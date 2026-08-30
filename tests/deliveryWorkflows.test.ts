import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { handoffCommand } from '../src/cli/commands/handoff';
import { deliveryCommand } from '../src/cli/commands/delivery';
import { validateDeliveryTargets } from '../src/delivery';

describe('GitHub Actions delivery workflows', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'seim-delivery-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'delivery-app',
      scripts: { typecheck: 'tsc --noEmit', test: 'jest', build: 'tsc', e2e: 'playwright test' },
      dependencies: { react: '^18.0.0', express: '^4.0.0' },
    }));
    fs.writeFileSync(path.join(root, 'server.js'), 'const app = require("express")();');
    fs.writeFileSync(path.join(root, 'Dockerfile'), 'FROM node:20-alpine');
    fs.mkdirSync(path.join(root, '.aws'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aws', 'task-definition.json'), JSON.stringify({ family: 'app', containerDefinitions: [{ name: 'app', image: 'placeholder' }] }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('generates verification, Vercel, AWS ECS, and rollback workflows', async () => {
    await handoffCommand([root]);
    await deliveryCommand([root, '--vercel', '--aws']);

    const workflow = (name: string) => fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8');
    const verify = workflow('seim-verify.yml');
    const vercel = workflow('seim-vercel-web.yml');
    const vercelRollback = workflow('seim-vercel-web-rollback.yml');
    const aws = workflow('seim-aws-api.yml');
    const awsRollback = workflow('seim-aws-api-rollback.yml');

    expect(verify).toContain('workflow_call:');
    expect(verify).toContain('permissions:\n  contents: read');
    expect(verify).toContain('npm ci');
    expect(verify).toContain('playwright test');

    expect(vercel).toContain('uses: ./.github/workflows/seim-verify.yml');
    expect(vercel).toContain('needs: verify');
    expect(vercel).toContain('vercel deploy --prebuilt --prod');
    expect(vercel).toContain('${{ secrets.VERCEL_TOKEN }}');
    expect(vercel).toContain('environment:\n      name: production');
    expect(vercelRollback).toContain('vercel rollback');
    expect(vercelRollback).toContain('workflow_dispatch:');

    expect(aws).toContain('id-token: write');
    expect(aws).toContain('aws-actions/configure-aws-credentials@v6');
    expect(aws).toContain('aws-actions/amazon-ecr-login@v2');
    expect(aws).toContain('docker/build-push-action@v6');
    expect(aws).toContain('${{ github.sha }}');
    expect(aws).toContain('wait-for-service-stability: true');
    expect(aws).not.toContain('AWS_ACCESS_KEY_ID');
    expect(awsRollback).toContain('Full known-good ECR image URI');
    expect(awsRollback).toContain('${{ inputs.image }}');

    const handoff = JSON.parse(fs.readFileSync(path.join(root, '.seim', 'handoff.json'), 'utf8'));
    expect(handoff.delivery.targets.map((target: any) => target.provider)).toEqual(['vercel', 'aws-ecs']);
  });

  it('rejects unsafe delivery paths, URLs, branches, and duplicate ids', () => {
    expect(() => validateDeliveryTargets([{ id: 'web', provider: 'vercel', workingDirectory: '../outside' }])).toThrow(/inside the repository/);
    expect(() => validateDeliveryTargets([{ id: 'web', provider: 'vercel', healthCheckUrl: 'http://example.com' }])).toThrow(/HTTPS/);
    expect(() => validateDeliveryTargets([{ id: 'web', provider: 'vercel', productionBranch: '../main' }])).toThrow(/safe Git branch/);
    expect(() => validateDeliveryTargets([{ id: 'web', provider: 'vercel' }, { id: 'web', provider: 'aws-ecs' }])).toThrow(/duplicate/);
  });
});
