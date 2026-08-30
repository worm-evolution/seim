#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

function printHelp(): void {
  console.log(`
seim - Self-optimizing runtime CLI

Usage: seim <command> [options]

Commands:
  init                  Scaffold a .seimrc.json config file
  handoff [dir]         Inspect an existing app and create .seim/handoff.json
  delivery [dir]        Generate GitHub Actions for --vercel and/or --aws
  status [url]          Show status of a running seim instance
  analyze <file>        Offline static analysis of a route file
  benchmark <url>       Run a simple benchmark against a URL
  rollback <route>      Trigger rollback for a route via API
  apply [dir]           Apply CI/CD-generated optimizations

Options:
  --help, -h            Show this help message
  --version, -v         Show version

Examples:
  seim init
  seim handoff .
  seim delivery . --vercel --aws
  seim status http://localhost:3000
  seim analyze ./routes/users.js
  seim benchmark http://localhost:3000/api/users
  seim rollback /api/users
`);
}

async function main(): Promise<void> {
  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    try {
      const pkg = require('../../package.json');
      console.log(pkg.version);
    } catch {
      console.log('unknown');
    }
    return;
  }

  try {
    switch (command) {
      case 'init': {
        const { initCommand } = require('./commands/init');
        await initCommand(args.slice(1));
        break;
      }
      case 'handoff': {
        const { handoffCommand } = require('./commands/handoff');
        await handoffCommand(args.slice(1));
        break;
      }
      case 'delivery': {
        const { deliveryCommand } = require('./commands/delivery');
        await deliveryCommand(args.slice(1));
        break;
      }
      case 'status': {
        const { statusCommand } = require('./commands/status');
        await statusCommand(args.slice(1));
        break;
      }
      case 'analyze': {
        const { analyzeCommand } = require('./commands/analyze');
        await analyzeCommand(args.slice(1));
        break;
      }
      case 'benchmark': {
        const { benchmarkCommand } = require('./commands/benchmark');
        await benchmarkCommand(args.slice(1));
        break;
      }
      case 'rollback': {
        const { rollbackCommand } = require('./commands/rollback');
        await rollbackCommand(args.slice(1));
        break;
      }
      case 'apply': {
        const { applyCommand } = require('./commands/apply');
        await applyCommand(args.slice(1));
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();
