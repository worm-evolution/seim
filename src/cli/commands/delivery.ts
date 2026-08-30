import * as path from 'path';
import { ProjectAdapter } from '../../engineer/projectAdapter';
import { HANDOFF_FILE, loadHandoffContract, writeHandoffContract } from '../../engineer/handoff';
import type { DeliveryTarget } from '../../engineer/types';
import { GitHubActionsDeliveryGenerator } from '../../delivery/workflowGenerator';
import { validateDeliveryTargets } from '../../delivery/validation';

export async function deliveryCommand(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const addVercel = args.includes('--vercel');
  const addAws = args.includes('--aws');
  const directoryArgument = args.find(argument => !argument.startsWith('-'));
  const rootDir = path.resolve(directoryArgument || process.cwd());
  const handoff = loadHandoffContract(rootDir);
  if (!handoff) throw new Error(`Run "seim handoff ${directoryArgument || '.'}" before configuring delivery`);

  const targets: DeliveryTarget[] = [...(handoff.delivery?.targets || [])];
  if (addVercel && !targets.some(target => target.provider === 'vercel')) {
    targets.push({ id: 'web', provider: 'vercel', workingDirectory: '.', productionBranch: handoff.repository.baseBranch });
  }
  if (addAws && !targets.some(target => target.provider === 'aws-ecs')) {
    targets.push({ id: 'api', provider: 'aws-ecs', workingDirectory: '.', productionBranch: handoff.repository.baseBranch, taskDefinition: '.aws/task-definition.json', containerName: 'app' });
  }
  const validated = validateDeliveryTargets(targets);
  if (validated.length === 0) throw new Error('No delivery targets configured; pass --vercel, --aws, or both');

  const manifest = new ProjectAdapter().inspect(rootDir, { handoff: { ...handoff, delivery: { targets: validated } } });
  const generator = new GitHubActionsDeliveryGenerator();
  const workflowFiles = generator.generate(manifest, validated);
  for (const file of workflowFiles) {
    const destination = path.join(rootDir, file.path);
    if (!force && require('fs').existsSync(destination)) throw new Error(`${file.path} already exists; use --force to replace it`);
  }
  const written = await generator.write(rootDir, manifest, validated, force);
  await writeHandoffContract(rootDir, { ...handoff, delivery: { targets: validated } }, true);

  console.log(`Updated ${HANDOFF_FILE} with ${validated.length} delivery target(s)`);
  for (const file of written) console.log(`Created ${file}`);
  if (validated.some(target => target.provider === 'vercel')) {
    console.log('Vercel GitHub configuration: secret VERCEL_TOKEN; variables VERCEL_ORG_ID and VERCEL_PROJECT_ID.');
  }
  if (validated.some(target => target.provider === 'aws-ecs')) {
    console.log('AWS GitHub variables: AWS_ROLE_ARN, AWS_REGION, AWS_ECR_REPOSITORY, AWS_ECS_CLUSTER, AWS_ECS_SERVICE, and optional AWS_HEALTHCHECK_URL.');
    console.log('AWS authentication uses GitHub OIDC; do not create long-lived AWS access-key secrets.');
  }
  console.log('Configure required reviewers and branch restrictions on the GitHub production environment before enabling deploy autonomy.');
}
