import * as fs from 'fs';
import * as path from 'path';
import type { AwsEcsDeliveryTarget, ChangeFile, DeliveryTarget, ProjectManifest, VercelDeliveryTarget } from '../engineer/types';
import { validateDeliveryTargets } from './validation';

export class GitHubActionsDeliveryGenerator {
  public generate(manifest: ProjectManifest, inputTargets?: DeliveryTarget[]): ChangeFile[] {
    const targets = validateDeliveryTargets(inputTargets || manifest.handoff?.delivery?.targets || []);
    const files: ChangeFile[] = [{ path: '.github/workflows/seim-verify.yml', operation: 'create', content: this.verificationWorkflow(manifest) }];
    for (const target of targets) {
      if (target.provider === 'vercel') {
        files.push({ path: `.github/workflows/seim-vercel-${target.id}.yml`, operation: 'create', content: this.vercelWorkflow(manifest, target) });
        files.push({ path: `.github/workflows/seim-vercel-${target.id}-rollback.yml`, operation: 'create', content: this.vercelRollbackWorkflow(target) });
      } else {
        files.push({ path: `.github/workflows/seim-aws-${target.id}.yml`, operation: 'create', content: this.awsWorkflow(manifest, target) });
        files.push({ path: `.github/workflows/seim-aws-${target.id}-rollback.yml`, operation: 'create', content: this.awsRollbackWorkflow(target) });
      }
    }
    return files;
  }

  public async write(rootDir: string, manifest: ProjectManifest, inputTargets?: DeliveryTarget[], overwrite = false): Promise<string[]> {
    const written: string[] = [];
    for (const file of this.generate(manifest, inputTargets)) {
      const destination = path.resolve(rootDir, file.path);
      const root = path.resolve(rootDir);
      if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`Delivery workflow escaped repository root: ${file.path}`);
      if (!overwrite && fs.existsSync(destination)) throw new Error(`${file.path} already exists; use --force to replace it`);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp.${process.pid}.${Date.now()}`;
      await fs.promises.writeFile(temporary, file.content || '', { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(temporary, destination);
      written.push(file.path);
    }
    return written;
  }

  private verificationWorkflow(manifest: ProjectManifest): string {
    const commands = [
      ['Typecheck', manifest.commands.typecheck],
      ['Test', manifest.commands.test],
      ['Integration tests', manifest.commands.integration],
      ['Build', manifest.commands.build],
      ['Browser tests', manifest.commands.browser],
    ].filter((item): item is [string, string] => Boolean(item[1]));
    const commandSteps = commands.map(([name, command]) => `      - name: ${name}\n        run: |\n${indentCommand(command, 10)}`).join('\n');
    return `name: SEIM Verification

on:
  workflow_call:
  pull_request:
  push:
    branches: [${yamlQuote(manifest.baseBranch)}]

permissions:
  contents: read

concurrency:
  group: seim-verify-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          package-manager-cache: false
      - name: Install dependencies
        run: |
${indentCommand(installCommand(manifest.packageManager), 10)}
${commandSteps ? `${commandSteps}\n` : ''}`;
  }

  private vercelWorkflow(manifest: ProjectManifest, target: VercelDeliveryTarget): string {
    const branch = target.productionBranch || manifest.baseBranch;
    const cwd = target.workingDirectory || '.';
    return `name: SEIM Vercel ${target.id}

on:
  pull_request:
    branches: [${yamlQuote(branch)}]
  push:
    branches: [${yamlQuote(branch)}]

permissions:
  contents: read

concurrency:
  group: seim-vercel-${target.id}-\${{ github.ref }}
  cancel-in-progress: true

env:
  VERCEL_ORG_ID: \${{ vars.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: \${{ vars.VERCEL_PROJECT_ID }}

jobs:
  verify:
    uses: ./.github/workflows/seim-verify.yml

  preview:
    needs: verify
    if: github.event_name == 'pull_request'
    environment:
      name: preview
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        working-directory: ${yamlQuote(cwd)}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          package-manager-cache: false
      - name: Install Vercel CLI
        run: npm install --global vercel@latest
      - name: Pull preview environment
        run: vercel pull --yes --environment=preview --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build preview
        run: vercel build --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy preview
        id: deploy
        run: |
          url=$(vercel deploy --prebuilt --token="\${{ secrets.VERCEL_TOKEN }}")
          echo "url=$url" >> "$GITHUB_OUTPUT"
      - name: Verify preview health
        run: curl --fail --show-error --silent --retry 5 --retry-all-errors "\${{ steps.deploy.outputs.url }}"

  production:
    needs: verify
    if: github.event_name == 'push'
    environment:
      name: production
      url: \${{ steps.deploy.outputs.url }}
    runs-on: ubuntu-latest
    timeout-minutes: 30
    defaults:
      run:
        working-directory: ${yamlQuote(cwd)}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          package-manager-cache: false
      - name: Install Vercel CLI
        run: npm install --global vercel@latest
      - name: Pull production environment
        run: vercel pull --yes --environment=production --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Build production
        run: vercel build --prod --token="\${{ secrets.VERCEL_TOKEN }}"
      - name: Deploy production
        id: deploy
        run: |
          url=$(vercel deploy --prebuilt --prod --token="\${{ secrets.VERCEL_TOKEN }}")
          echo "url=$url" >> "$GITHUB_OUTPUT"
      - name: Verify production health
        run: curl --fail --show-error --silent --retry 5 --retry-all-errors "${target.healthCheckUrl || '\${{ steps.deploy.outputs.url }}'}"
`;
  }

  private vercelRollbackWorkflow(target: VercelDeliveryTarget): string {
    const cwd = target.workingDirectory || '.';
    return `name: SEIM Vercel ${target.id} Rollback

on:
  workflow_dispatch:
    inputs:
      deployment:
        description: Optional known-good deployment ID or URL; empty rolls back one production deployment
        required: false
        type: string

permissions:
  contents: read

concurrency:
  group: seim-vercel-${target.id}-production
  cancel-in-progress: false

env:
  VERCEL_ORG_ID: \${{ vars.VERCEL_ORG_ID }}
  VERCEL_PROJECT_ID: \${{ vars.VERCEL_PROJECT_ID }}

jobs:
  rollback:
    environment: production
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${yamlQuote(cwd)}
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '20'
          package-manager-cache: false
      - run: npm install --global vercel@latest
      - name: Roll back production
        env:
          TARGET_DEPLOYMENT: \${{ inputs.deployment }}
        run: |
          if [ -n "$TARGET_DEPLOYMENT" ]; then
            vercel rollback "$TARGET_DEPLOYMENT" --token="\${{ secrets.VERCEL_TOKEN }}"
          else
            vercel rollback --token="\${{ secrets.VERCEL_TOKEN }}"
          fi
      - run: vercel rollback status --token="\${{ secrets.VERCEL_TOKEN }}"
`;
  }

  private awsWorkflow(manifest: ProjectManifest, target: AwsEcsDeliveryTarget): string {
    const branch = target.productionBranch || manifest.baseBranch;
    const cwd = target.workingDirectory || '.';
    return `name: SEIM AWS ECS ${target.id}

on:
  push:
    branches: [${yamlQuote(branch)}]

permissions:
  contents: read
  id-token: write

concurrency:
  group: seim-aws-${target.id}-production
  cancel-in-progress: false

env:
  AWS_REGION: \${{ vars.AWS_REGION }}
  ECR_REPOSITORY: \${{ vars.AWS_ECR_REPOSITORY }}
  ECS_CLUSTER: \${{ vars.AWS_ECS_CLUSTER }}
  ECS_SERVICE: \${{ vars.AWS_ECS_SERVICE }}

jobs:
  verify:
    uses: ./.github/workflows/seim-verify.yml

  deploy:
    needs: verify
    environment: production
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v6
      - name: Configure short-lived AWS credentials
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: \${{ vars.AWS_ROLE_ARN }}
          aws-region: \${{ env.AWS_REGION }}
          mask-aws-account-id: true
      - name: Log in to Amazon ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - uses: docker/setup-buildx-action@v3
      - name: Build and push immutable image
        uses: docker/build-push-action@v6
        with:
          context: ${yamlQuote(cwd)}
          file: ${yamlQuote(path.posix.join(cwd, 'Dockerfile'))}
          push: true
          tags: \${{ steps.ecr.outputs.registry }}/\${{ env.ECR_REPOSITORY }}:\${{ github.sha }}
          provenance: true
          sbom: true
      - name: Render task definition
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: ${yamlQuote(target.taskDefinition)}
          container-name: ${yamlQuote(target.containerName)}
          image: \${{ steps.ecr.outputs.registry }}/\${{ env.ECR_REPOSITORY }}:\${{ github.sha }}
      - name: Deploy and wait for service stability
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: \${{ steps.render.outputs.task-definition }}
          service: \${{ env.ECS_SERVICE }}
          cluster: \${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
      - name: Verify production health
        env:
          HEALTHCHECK_URL: ${yamlQuote(target.healthCheckUrl || '${{ vars.AWS_HEALTHCHECK_URL }}')}
        run: |
          if [ -n "$HEALTHCHECK_URL" ]; then
            curl --fail --show-error --silent --retry 8 --retry-all-errors "$HEALTHCHECK_URL"
          fi
`;
  }

  private awsRollbackWorkflow(target: AwsEcsDeliveryTarget): string {
    return `name: SEIM AWS ECS ${target.id} Rollback

on:
  workflow_dispatch:
    inputs:
      image:
        description: Full known-good ECR image URI including immutable tag or digest
        required: true
        type: string

permissions:
  contents: read
  id-token: write

concurrency:
  group: seim-aws-${target.id}-production
  cancel-in-progress: false

env:
  AWS_REGION: \${{ vars.AWS_REGION }}
  ECS_CLUSTER: \${{ vars.AWS_ECS_CLUSTER }}
  ECS_SERVICE: \${{ vars.AWS_ECS_SERVICE }}

jobs:
  rollback:
    environment: production
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: \${{ vars.AWS_ROLE_ARN }}
          aws-region: \${{ env.AWS_REGION }}
          mask-aws-account-id: true
      - name: Render known-good image
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: ${yamlQuote(target.taskDefinition)}
          container-name: ${yamlQuote(target.containerName)}
          image: \${{ inputs.image }}
      - name: Deploy rollback and wait for stability
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: \${{ steps.render.outputs.task-definition }}
          service: \${{ env.ECS_SERVICE }}
          cluster: \${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
`;
  }
}

function installCommand(packageManager: ProjectManifest['packageManager']): string {
  if (packageManager === 'pnpm') return 'corepack enable\npnpm install --frozen-lockfile';
  if (packageManager === 'yarn') return 'corepack enable\nyarn install --immutable';
  return 'npm ci';
}
function indentCommand(command: string, spaces: number): string { const prefix = ' '.repeat(spaces); return command.split(/\r?\n/).map(line => `${prefix}${line}`).join('\n'); }
function yamlQuote(value: string): string { return JSON.stringify(value); }
