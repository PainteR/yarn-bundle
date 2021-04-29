module.exports = {
  name: `plugin-bundle`,
  factory: (require) => {
    const { BaseCommand, WorkspaceRequiredError } = require("@yarnpkg/cli");
    const {
      Cache,
      Configuration,
      Manifest,
      Project,
      StreamReport,
    } = require("@yarnpkg/core");
    const { getLibzipPromise } = require("@yarnpkg/libzip");
    const { xfs, NodeFS, ZipFS, ppath, Filename } = require("@yarnpkg/fslib");
    const path = require("path");

    class Bundler extends BaseCommand {
      constructor() {
        super(...arguments);
        this.json = false;
        this.archiveName = `bundle.zip`;
        this.exclude = [];
      }

      async removeUnusedPackages(tmpDir, tmpPackageCwd, configuration) {
        const { project, workspace } = await Project.find(
          configuration,
          tmpPackageCwd
        );
        if (!workspace)
          throw new WorkspaceRequiredError(project.cwd, tmpPackageCwd);
        const requiredWorkspaces = new Set([workspace]);
        for (const workspace of requiredWorkspaces) {
          for (const dependencyType of Manifest.hardDependencies) {
            for (const descriptor of workspace.manifest
              .getForScope(dependencyType)
              .values()) {
              const matchingWorkspace = project.tryWorkspaceByDescriptor(
                descriptor
              );
              if (matchingWorkspace === null) continue;
              requiredWorkspaces.add(matchingWorkspace);
            }
          }
        }
        for (const workspace of project.workspaces) {
          if (requiredWorkspaces.has(workspace)) continue;
          if (workspace.cwd !== tmpDir) {
            await xfs.removePromise(workspace.cwd);
          }
        }
      }

      async removeExcluded(tmpDir, excluded) {
        const gitDir = `${tmpDir}/.git`;
        try {
          if (await xfs.lstatPromise(gitDir)) {
            await xfs.removePromise(gitDir);
          }
        } catch (e) {}
        await excluded.map(async (p) => {
          if (!p.startsWith(tmpDir)) {
            // Don't remove anything not in the tmp directory
            return;
          }
          if (await xfs.lstatPromise(p)) {
            await xfs.removePromise(p);
          }
        });
      }

      async execute() {
        // Get a tmpDir to work in
        return await xfs.mktempPromise(async (tmpDir) => {
          // Save the originalCWD so we can store the archive somewhere
          const originalCwd = `${this.context.cwd}`;
          const outputArchive = ppath.join(originalCwd, this.archiveName);
          // Get the configuration where our source code is
          const sourceConfiguration = await Configuration.find(
            this.context.cwd,
            this.context.plugins
          );
          if (sourceConfiguration.projectCwd === null) {
            throw new Error("Can't find project directory");
          }
          // find the relative dir of the package thats selected
          const packageCwd = originalCwd.replace(
            sourceConfiguration.projectCwd,
            ""
          );
          // copy everything to the tmpDir
          const baseFs = new NodeFS();
          await xfs.copyPromise(tmpDir, sourceConfiguration.projectCwd, {
            baseFs,
          });
          const tmpPackageCwd = `${tmpDir}${packageCwd}`;
          const exclude = this.exclude;
          const previousArchive = `${tmpPackageCwd}/${this.archiveName}`;
          try {
            if (await xfs.lstatPromise(previousArchive)) {
              exclude.push(previousArchive);
            }
          } catch (e) {}
          // Remove stuff we dont need
          await this.removeExcluded(tmpDir, exclude);
          const configuration = await Configuration.find(
            tmpPackageCwd,
            this.context.plugins
          );
          const cache = await Cache.find(configuration);
          await this.removeUnusedPackages(tmpDir, tmpPackageCwd, configuration);
          const { project, workspace } = await Project.find(
            configuration,
            tmpPackageCwd
          );
          if (!workspace)
            throw new WorkspaceRequiredError(project.cwd, tmpPackageCwd);
          const requiredWorkspaces = new Set([workspace]);
          for (const workspace of requiredWorkspaces) {
            for (const dependencyType of Manifest.hardDependencies) {
              for (const descriptor of workspace.manifest
                .getForScope(dependencyType)
                .values()) {
                const matchingWorkspace = project.tryWorkspaceByDescriptor(
                  descriptor
                );
                if (matchingWorkspace === null) continue;
                requiredWorkspaces.add(matchingWorkspace);
              }
            }
          }
          for (const workspace of project.workspaces) {
            workspace.manifest.devDependencies.clear();
            if (requiredWorkspaces.has(workspace)) continue;
            workspace.manifest.dependencies.clear();
            workspace.manifest.peerDependencies.clear();
          }
          if (workspace?.manifest?.raw?.main) {
            // Add entrypoint
            // TODO: make mainFile configurable
            const mainFile =
              workspace.relativeCwd + path.sep + workspace?.manifest?.raw?.main;
            const pnp = `./.pnp.js`;
            xfs.writeFilePromise(
              `${tmpDir}${path.sep}entrypoint.js`,
              generateEntrypointFile(mainFile, pnp)
            );
          }
          const report = await StreamReport.start(
            {
              configuration,
              json: this.json,
              stdout: this.context.stdout,
              includeLogs: true,
            },
            async (report) => {
              // Install and remove everything we dont need
              await project.install({ cache, report });
              report.reportInfo(null, "Getting libzip");
              const libzip = await getLibzipPromise();
              report.reportInfo(null, "Creating archive");
              const zipFs = new ZipFS(outputArchive, {
                create: true,
                libzip,
              });
              const prefixPath = "bundle";
              report.reportInfo(null, "Copying files to archive");
              await zipFs.copyPromise(prefixPath, tmpDir, {
                baseFs,
              });
              zipFs.saveAndClose();
              report.reportJson({
                name: "ArchiveSuccess",
                message: "Archive created successfuly at ",
                outputArchive,
              });
            }
          );
          return report.exitCode();
        });
      }
    }

    Bundler.addPath(`bundle`);
    // Bundler.addOption("json", Command.Boolean(`--json`));
    // Bundler.addOption("exclude", Command.Array(`--exclude`));
    // Bundler.addOption("archiveName", Command.String(`-a,--archive-name`));
    // Bundler.addOption(
    //   "outputDirectory",
    //   Command.String(`-o,--output-directory`)
    // );

    // Bundler.usage = Command.Usage({
    //   category: `Build commands`,
    //   description: `bundle a workspace package into a deployable archive`,
    //   details: `
    //     This command will bundle up the source of the target package along with
    //     its dependencies into an archive.
    //     This is designed to be used for deployment, not for publishing, so
    //     everything to run except for a runtime (ie node) is bundled into
    //     the archive.
    //     Call this after you have run your build step (if any).
    //     This is designed to work best with zero-install configurations. If you
    //     don't have that, run \`yarn install\` before this command.
    //     Why not just compile like we do on the front-end?
    //     Some dependencies may use require in interesting ways, or be or call
    //     binaries. It's safest not to transpile them.
    //     If the \`--json\` flag is set the output will follow a JSON-stream output
    //     also known as NDJSON (https://github.com/ndjson/ndjson-spec).
    //     \`-o,--output-directory\` sets the output directory.
    //     \`-a,--archive-name\` sets the name of the archive. Any files matching
    //     this, will be excluded from subsequent archives. Defaults to ./bundle.tgz
    //   `,
    // });

    return {
      commands: [Bundler],
    };
  },
};
