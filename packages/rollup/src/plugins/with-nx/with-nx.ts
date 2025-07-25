import {
  logger,
  type ProjectGraph,
  readCachedProjectGraph,
  readJsonFile,
  workspaceRoot,
} from '@nx/devkit';
import { typeDefinitions } from '@nx/js/src/plugins/rollup/type-definitions';
import {
  calculateProjectBuildableDependencies,
  computeCompilerOptionsPaths,
  createTmpTsConfig,
  DependentBuildableProjectNode,
} from '@nx/js/src/utils/buildable-libs-utils';
import {
  getProjectSourceRoot,
  isUsingTsSolutionSetup,
} from '@nx/js/src/utils/typescript/ts-solution-setup';
import { getBabelInputPlugin } from '@rollup/plugin-babel';
import nodeResolve from '@rollup/plugin-node-resolve';
import * as autoprefixer from 'autoprefixer';
import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { PackageJson } from 'nx/src/utils/package-json';
import * as rollup from 'rollup';
import { analyze } from '../analyze';
import { deleteOutput } from '../delete-output';
import { generatePackageJson } from '../package-json/generate-package-json';
import { swc } from '../swc';
import { getProjectNode } from './get-project-node';
import { normalizeOptions } from './normalize-options';
import { AssetGlobPattern, RollupWithNxPluginOptions } from './with-nx-options';

// These use require because the ES import isn't correct.
const commonjs = require('@rollup/plugin-commonjs');
const image = require('@rollup/plugin-image');

const json = require('@rollup/plugin-json');
const copy = require('rollup-plugin-copy');
const postcss = require('rollup-plugin-postcss');

const fileExtensions = ['.js', '.jsx', '.ts', '.tsx'];

let ts: typeof import('typescript');

function ensureTypeScript() {
  if (!ts) {
    try {
      ts = require('typescript');
    } catch (e) {
      throw new Error(
        'TypeScript is required for the @nx/rollup plugin. Please install it in your workspace.'
      );
    }
  }
  return ts;
}

export function withNx(
  rawOptions: RollupWithNxPluginOptions,
  rollupConfig: rollup.RollupOptions = {},
  // Passed by @nx/rollup:rollup executor to previous behavior of remapping tsconfig paths based on buildable dependencies remains intact.
  dependencies?: DependentBuildableProjectNode[]
): rollup.RollupOptions {
  const finalConfig: rollup.RollupOptions = { ...rollupConfig };

  // Since this is invoked by the executor, the graph has already been created and cached.
  const projectNode = getProjectNode();
  const projectRoot = join(workspaceRoot, projectNode.data.root);

  // Cannot read in graph during construction, but we only need it during build time.
  const projectGraph: ProjectGraph | null = global.NX_GRAPH_CREATION
    ? null
    : readCachedProjectGraph();

  // If dependencies are not passed from executor, calculate them from project graph.
  if (!dependencies && !global.NX_GRAPH_CREATION) {
    const result = calculateProjectBuildableDependencies(
      undefined,
      projectGraph,
      workspaceRoot,
      projectNode.name,
      process.env.NX_TASK_TARGET_TARGET,
      process.env.NX_TASK_TARGET_CONFIGURATION,
      true
    );
    dependencies = result.dependencies;
  }

  const projectSourceRoot = getProjectSourceRoot(projectNode.data);
  const options = normalizeOptions(
    projectNode.data.root,
    projectSourceRoot,
    rawOptions
  );

  const useBabel = options.compiler === 'babel';
  const useSwc = options.compiler === 'swc';

  const tsConfigPath =
    options.buildLibsFromSource || global.NX_GRAPH_CREATION
      ? join(workspaceRoot, options.tsConfig)
      : createTmpTsConfig(
          options.tsConfig,
          workspaceRoot,
          projectRoot,
          dependencies
        );

  ensureTypeScript();
  const tsConfigFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
  const tsConfig = ts.parseJsonConfigFileContent(
    tsConfigFile.config,
    ts.sys,
    dirname(tsConfigPath)
  );

  if (!options.format || !options.format.length) {
    options.format = readCompatibleFormats(tsConfig);
  }

  if (
    rollupConfig.input &&
    (options.main || options.additionalEntryPoints.length > 0)
  ) {
    logger.warn(
      `Setting "input" in rollup config overrides "main" and "additionalEntryPoints" options.`
    );
  }

  // If user provides their own input, override our defaults.
  finalConfig.input = rollupConfig.input || createInput(options);

  if (options.format) {
    if (Array.isArray(rollupConfig.output)) {
      throw new Error(
        `Cannot use Rollup array output option and withNx format option together. Use an object instead.`
      );
    }
    if (rollupConfig.output?.format || rollupConfig.output?.dir) {
      logger.warn(
        `"output.dir" and "output.format" are overridden by "withNx".`
      );
    }

    finalConfig.output = options.format.map((format) => ({
      // These options could be overridden by the user, especially if they use a single format.
      entryFileNames: `[name].${format}.js`,
      chunkFileNames: `[name].${format}.js`,
      ...rollupConfig.output,
      // Format and dir cannot be overridden by user or else the behavior will break.
      format,
      dir: global.NX_GRAPH_CREATION
        ? // Options are not normalized with project root during graph creation due to the lack of project and project root.
          // Cannot be joined with workspace root now, but will be handled by @nx/rollup/plugin.
          options.outputPath
        : join(workspaceRoot, options.outputPath),
      sourcemap: options.sourceMap,
    }));
  }

  let packageJson: PackageJson;
  if (!global.NX_GRAPH_CREATION) {
    const packageJsonPath = options.project
      ? join(workspaceRoot, options.project)
      : join(projectRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      throw new Error(`Cannot find ${packageJsonPath}.`);
    }

    packageJson = readJsonFile(packageJsonPath);

    if (packageJson.type === 'module') {
      if (options.format.includes('cjs')) {
        logger.warn(
          `Package type is set to "module" but "cjs" format is included. Going to use "esm" format instead. You can change the package type to "commonjs" or remove type in the package.json file.`
        );
      }
      options.format = ['esm'];
    } else if (packageJson.type === 'commonjs') {
      if (options.format.includes('esm')) {
        logger.warn(
          `Package type is set to "commonjs" but "esm" format is included. Going to use "cjs" format instead. You can change the package type to "module" or remove type in the package.json file.`
        );
      }
      options.format = ['cjs'];
    }
  }

  // User may wish to customize how external behaves by overriding our default.
  if (!rollupConfig.external && !global.NX_GRAPH_CREATION) {
    const npmDeps = (projectGraph.dependencies[projectNode.name] ?? [])
      .filter((d) => d.target.startsWith('npm:'))
      .map((d) => d.target.slice(4));
    let externalPackages = [
      ...Object.keys(packageJson.dependencies || {}),
      ...Object.keys(packageJson.peerDependencies || {}),
    ]; // If external is set to none, include all dependencies and peerDependencies in externalPackages
    if (options.external === 'all') {
      externalPackages = externalPackages.concat(npmDeps);
    } else if (Array.isArray(options.external) && options.external.length > 0) {
      externalPackages = externalPackages.concat(options.external);
    }
    externalPackages = [...new Set(externalPackages)];
    finalConfig.external = (id: string) => {
      return externalPackages.some(
        (name) => id === name || id.startsWith(`${name}/`)
      );
    };
  }

  if (!global.NX_GRAPH_CREATION) {
    // Ensure TypeScript is available before any plugin initialization
    ensureTypeScript();

    const isTsSolutionSetup = isUsingTsSolutionSetup();
    if (isTsSolutionSetup) {
      if (options.generatePackageJson) {
        throw new Error(
          `Setting 'generatePackageJson: true' is not supported with the current TypeScript setup. Update the 'package.json' file at the project root as needed and unset the 'generatePackageJson' option.`
        );
      }
      if (options.generateExportsField) {
        throw new Error(
          `Setting 'generateExportsField: true' is not supported with the current TypeScript setup. Set 'exports' field in the 'package.json' file at the project root and unset the 'generateExportsField' option.`
        );
      }
    } else {
      options.generatePackageJson ??= true;
    }

    const compilerOptions: Record<string, unknown> = createTsCompilerOptions(
      projectRoot,
      tsConfig,
      options,
      dependencies
    );
    compilerOptions.outDir = Array.isArray(finalConfig.output)
      ? finalConfig.output[0].dir
      : finalConfig.output.dir;

    finalConfig.plugins = [
      copy({
        targets: convertCopyAssetsToRollupOptions(
          options.outputPath,
          options.assets
        ),
      }),
      image(),
      json(),
      // TypeScript compilation and declaration generation
      // TODO(v22): Change default value of useLegacyTypescriptPlugin to false for Nx 22
      options.useLegacyTypescriptPlugin !== false
        ? (() => {
            // TODO(v23): Remove in Nx 23
            // Show deprecation warning
            logger.warn(
              `rollup-plugin-typescript2 usage is deprecated and will be removed in Nx 23. ` +
                `Set 'useLegacyTypescriptPlugin: false' to use the official @rollup/plugin-typescript.`
            );

            return require('rollup-plugin-typescript2')({
              check: !options.skipTypeCheck,
              tsconfig: tsConfigPath,
              tsconfigOverride: {
                compilerOptions,
              },
            });
          })()
        : (() => {
            // @rollup/plugin-typescript needs outDir and declarationDir to match Rollup's output directory
            const { outDir, declarationDir, ...tsCompilerOptions } =
              compilerOptions;
            const rollupOutputDir = Array.isArray(finalConfig.output)
              ? finalConfig.output[0].dir
              : finalConfig.output.dir;
            return require('@rollup/plugin-typescript')({
              tsconfig: tsConfigPath,
              compilerOptions: {
                ...tsCompilerOptions,
                outDir: rollupOutputDir,
                declarationDir: rollupOutputDir,
              },
              declaration: true,
              declarationMap: !!options.sourceMap,
              noEmitOnError: !options.skipTypeCheck,
            });
          })(),
      typeDefinitions({
        projectRoot,
      }),
      postcss({
        inject: true,
        extract: options.extractCss,
        autoModules: true,
        plugins: [autoprefixer],
        use: {
          less: {
            javascriptEnabled: options.javascriptEnabled,
          },
        },
      }),
      nodeResolve({
        preferBuiltins: true,
        extensions: fileExtensions,
      }),
      useSwc && swc(),
      useBabel &&
        getBabelInputPlugin({
          // Lets `@nx/js/babel` preset know that we are packaging.
          caller: {
            // @ts-ignore
            // Ignoring type checks for caller since we have custom attributes
            isNxPackage: true,
            // Always target esnext and let rollup handle cjs
            supportsStaticESM: true,
            isModern: true,
          },
          cwd: join(workspaceRoot, projectSourceRoot),
          rootMode: options.babelUpwardRootMode ? 'upward' : undefined,
          babelrc: true,
          extensions: fileExtensions,
          babelHelpers: 'bundled',
          skipPreflightCheck: true, // pre-flight check may yield false positives and also slows down the build
          exclude: /node_modules/,
        }),
      commonjs(),
      analyze(),
      options.generatePackageJson && generatePackageJson(options, packageJson),
    ].filter(Boolean);
    if (Array.isArray(rollupConfig.plugins)) {
      finalConfig.plugins.push(...rollupConfig.plugins);
    }
    if (options.deleteOutputPath) {
      finalConfig.plugins.push(
        deleteOutput({
          dirs: Array.isArray(finalConfig.output)
            ? finalConfig.output.map((o) => o.dir)
            : [finalConfig.output.dir],
        })
      );
    }
  }

  return finalConfig;
}

function createInput(
  options: RollupWithNxPluginOptions
): Record<string, string> {
  // During graph creation, these input entries don't affect target configuration, so we can skip them.
  // If convert-to-inferred generator is used, and project uses configurations, some options like main might be missing from default options.
  if (global.NX_GRAPH_CREATION) return {};
  const mainEntryFileName = options.outputFileName || options.main;
  const input: Record<string, string> = {};
  input[parse(mainEntryFileName).name] = join(workspaceRoot, options.main);
  options.additionalEntryPoints?.forEach((entry) => {
    input[parse(entry).name] = join(workspaceRoot, entry);
  });
  return input;
}

function createTsCompilerOptions(
  projectRoot: string,
  config: ReturnType<typeof ts.parseJsonConfigFileContent>,
  options: RollupWithNxPluginOptions,
  dependencies?: DependentBuildableProjectNode[]
) {
  const compilerOptionPaths = computeCompilerOptionsPaths(
    config,
    dependencies ?? []
  );
  const compilerOptions = {
    rootDir: projectRoot,
    allowJs: options.allowJs,
    declaration: true,
    paths: compilerOptionPaths,
  };
  ensureTypeScript();
  if (config.options.module === ts.ModuleKind.CommonJS) {
    compilerOptions['module'] = 'ESNext';
  }
  if (options.compiler === 'swc') {
    compilerOptions['emitDeclarationOnly'] = true;
  }
  return compilerOptions;
}

interface RollupCopyAssetOption {
  src: string;
  dest: string;
}

function convertCopyAssetsToRollupOptions(
  outputPath: string,
  assets: AssetGlobPattern[]
): RollupCopyAssetOption[] {
  return assets
    ? assets.map((a) => ({
        src: join(a.input, a.glob).replace(/\\/g, '/'),
        dest: join(workspaceRoot, outputPath, a.output).replace(/\\/g, '/'),
      }))
    : undefined;
}

function readCompatibleFormats(
  config: ReturnType<typeof ts.parseJsonConfigFileContent>
): ('cjs' | 'esm')[] {
  ensureTypeScript();
  switch (config.options.module) {
    case ts.ModuleKind.CommonJS:
    case ts.ModuleKind.UMD:
    case ts.ModuleKind.AMD:
      return ['cjs'];
    default:
      return ['esm'];
  }
}
