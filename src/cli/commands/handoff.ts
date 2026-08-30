import * as path from 'path';
import { ProjectAdapter } from '../../engineer/projectAdapter';
import { createHandoffContract, HANDOFF_FILE, writeHandoffContract } from '../../engineer/handoff';

export async function handoffCommand(args: string[]): Promise<void> {
  const force = args.includes('--force');
  const directoryArgument = args.find(argument => !argument.startsWith('-'));
  const rootDir = path.resolve(directoryArgument || process.cwd());
  const adapter = new ProjectAdapter();
  const manifest = adapter.inspect(rootDir);
  const contract = createHandoffContract(manifest);
  const filePath = await writeHandoffContract(rootDir, contract, force);

  console.log(`Created ${path.relative(process.cwd(), filePath) || HANDOFF_FILE}`);
  console.log(`Application: ${contract.application.name}`);
  console.log(`Stack: frontend=${manifest.frontendContext.framework}, backend=${manifest.backend}`);
  console.log(`Context: ${manifest.contextIndex.indexedFiles} files, ${manifest.contextIndex.testFiles.length} tests, ${manifest.contextIndex.apiContractFiles.length} API contracts`);
  console.log(`Autonomy: ${contract.policies.autonomy} (verified pull requests; merging remains blocked)`);
  console.log('Review the protected paths, approval paths, commands, and autonomy before enabling the engineer.');
}
