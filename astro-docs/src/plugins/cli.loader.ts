import { workspaceRoot } from '@nx/devkit';
import { join, relative } from 'path';
import { fork } from 'child_process';
import type { ParsedCommand } from './utils/nx-command-parser';
import type { Loader, LoaderContext } from 'astro/loaders';
import { watchAndCall } from './utils/watch.ts';

function generateCLIMarkdown(commands: Record<string, ParsedCommand>): string {
  const commandNames = Object.keys(commands).sort();

  const content = `
The Nx command line has various subcommands and options to help you manage your Nx workspace and run tasks efficiently. 
Below is a complete reference for all available commands and their options.
You can run nx --help to view all available options. 

## Available Commands

${commandNames
  .map((cmdName) => {
    const cmd = commands[cmdName];
    let section = `### \`nx ${cmdName}\`\n`;

    section += cmd.description || 'No description available';

    if (cmd.aliases && cmd.aliases.length > 0) {
      section += `**Aliases:** ${cmd.aliases
        .map((alias) => `\`${alias}\``)
        .join(', ')}`;
    }

    section += `\n\n**Usage:**
\`\`\`bash
nx ${cmd.command || cmdName}
\`\`\`
`;

    // Add options table if there are options
    if (cmd.options && cmd.options.length > 0) {
      section += '\n#### Options\n\n';
      section += '| Option | Type | Description | Default |\n';
      section += '|--------|------|-------------|---------|\n';

      const sortedOptions = cmd.options.sort((a, b) =>
        a.name[0].localeCompare(b.name[0])
      );

      for (const option of sortedOptions) {
        const optionNames = option.name.map((n) => `\`--${n}\``).join(', ');
        let description = option.description || '';

        // Add alias information
        if (option.name.length > 1) {
          const aliases = option.name
            .slice(1)
            .map((a) => `\`-${a}\``)
            .join(', ');
          description += ` (alias: ${aliases})`;
        }

        // Add deprecation warning
        if (option.deprecated) {
          description += ` **⚠️ Deprecated**${
            option.deprecated !== true ? `: ${option.deprecated}` : ''
          }`;
        }

        // Add choices if available
        if (option.choices && option.choices.length > 0) {
          description += ` (choices: ${option.choices
            .map((c) => `\`${c}\``)
            .join(', ')})`;
        }

        const defaultValue =
          option.default !== undefined
            ? `\`${JSON.stringify(option.default).replace(/"/g, '')}\``
            : '';

        section += `| ${optionNames} | ${option.type} | ${
          description || '_No Description_'
        } | ${defaultValue} |\n`;
      }

      section += '\n';
    }

    return section;
  })
  .join('\n')}

## Getting Help

You can get help for any command by adding the \`--help\` flag:

\`\`\`bash
nx <command> --help
\`\`\`
`;

  return content;
}

export interface CliDocEntry {
  id: string;
  body: string;
  rendered?: any;
  filePath: string;
  data: {
    title: string;
    docType: 'cli';
    content: string;
  };
}

export async function generateNxCliDocs(
  logger: LoaderContext['logger'],
  watcher?: LoaderContext['watcher']
): Promise<CliDocEntry> {
  logger.info('🔍 Generating Nx CLI documentation...');

  try {
    // Run the CLI parser in a subprocess to avoid ESM/CJS issues
    const subprocessPath = join(
      workspaceRoot,
      'astro-docs/src/plugins/utils/cli-subprocess.cjs'
    );

    // Run subprocess and get results
    const result = await new Promise<{
      commands: Record<string, ParsedCommand>;
    }>((resolve, reject) => {
      const child = fork(subprocessPath, [], {
        cwd: workspaceRoot,
        silent: true,
        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      });

      child.on('message', (message: any) => {
        if (message.type === 'result') {
          resolve(message.data);
        } else if (message.type === 'error') {
          reject(new Error(message.error));
        }
        child.send({ type: 'stop' });
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`CLI subprocess exited with code ${code}`));
        }
      });

      child.send({ type: 'start' });
    });

    const markdown = generateCLIMarkdown(result.commands);

    logger.info(
      `✅ Generated CLI documentation with ${
        Object.keys(result.commands).length
      } commands`
    );

    return {
      id: 'api/nx-cli',
      body: markdown,
      filePath: relative(
        join(workspaceRoot, 'astro-docs'),
        join(workspaceRoot, 'packages/nx/src/command-line/nx-commands.ts')
      ),
      data: {
        title: 'Nx CLI Reference',
        docType: 'cli',
        content: markdown,
      },
    };
  } catch (error: any) {
    logger.error('❌ Failed to generate CLI docs:');
    logger.error(error.message);
    throw error;
  }
}

export function CliLoader(options: any = {}): Loader {
  return {
    name: 'nx-cli-loader',
    async load({ store, logger, watcher, renderMarkdown }: LoaderContext) {
      const generate = async () => {
        const doc = await generateNxCliDocs(logger, watcher);
        logger.info('Loaded CLI documentation');

        store.clear();

        if (doc.body) {
          doc.rendered = await renderMarkdown(doc.body);
        }

        logger.info(`Processing CLI documentation`);
        store.set(doc);

        logger.info('Generated CLI documentation');
      };

      const pathsToWatch = [
        join(import.meta.dirname, 'cli.loader.ts'),
        join(import.meta.dirname, 'utils/cli-subprocess.cjs'),
        join(import.meta.dirname, 'utils/typedoc'),
      ];

      if (watcher) {
        watchAndCall(watcher, pathsToWatch, generate);
      }

      await generate();
    },
  };
}
