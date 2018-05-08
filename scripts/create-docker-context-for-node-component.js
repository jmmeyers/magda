#!/usr/bin/env node

const childProcess = require("child_process");
const fse = require("fs-extra");
const path = require("path");
const process = require("process");
const yargs = require("yargs");

const argv = yargs
    .options({
        build: {
            description: "Pipe the Docker context straight to Docker.",
            type: "boolean",
            default: false
        },
        tag: {
            description:
                'The tag to pass to "docker build".  This parameter is only used if --build is specified.  If the value of this parameter is `auto`, a tag name is automatically created from NPM configuration.',
            type: "string",
            default: "auto"
        },
        repository: {
            description:
                "The repository to use in auto tag generation. Will default to '', i.e. dockerhub unless --local is set. Requires --tag=auto",
            type: "string"
        },
        version: {
            description:
                "The version(s) to use in auto tag generation. Will default to the current version in package.json. Requires --tag=auto",
            type: "string",
            array: true
        },
        output: {
            description:
                "The output path and filename for the Docker context .tar file.",
            type: "string"
        },
        local: {
            description:
                "Build for a local Kubernetes container registry.  This parameter is only used if --build is specified.",
            type: "boolean",
            default: false
        },
        push: {
            description:
                "Push the build image to the docker registry.  This parameter is only used if --build is specified.",
            type: "boolean",
            default: false
        },
        cacheFromVersion: {
            description:
                "Version to cache from when building, using the --cache-from field in docker. Will use the same repository and name. Using this options causes the image to be pulled before build.",
            type: "string"
        }
    })
    .help().argv;

if (!argv.build && !argv.output) {
    console.log("Either --build or --output <filename> must be specified.");
    process.exit(1);
}

const componentSrcDir = path.resolve(process.cwd());
const dockerContextDir = fse.mkdtempSync(
    path.resolve(__dirname, "..", "docker-context-")
);
const componentDestDir = path.resolve(dockerContextDir, "component");

fse.emptyDirSync(dockerContextDir);
fse.ensureDirSync(componentDestDir);
fse.ensureSymlinkSync(
    path.resolve(componentSrcDir, "..", "node_modules"),
    path.resolve(dockerContextDir, "node_modules"),
    "junction"
);

preparePackage(componentSrcDir, componentDestDir);

const tar = process.platform === "darwin" ? "gtar" : "tar";

// Docker and ConEmu (an otherwise excellent console for Windows) don't get along.
// See: https://github.com/Maximus5/ConEmu/issues/958 and https://github.com/moby/moby/issues/28814
// So if we're running under ConEmu, we need to add an extra -cur_console:i parameter to disable
// ConEmu's hooks and also set ConEmuANSI to OFF so Docker doesn't do anything drastic.
const env = Object.assign({}, process.env);
const extraParameters = [];
if (env.ConEmuANSI === "ON") {
    env.ConEmuANSI = "OFF";
    extraParameters.push("-cur_console:i");
}

updateDockerFile(componentSrcDir, componentDestDir);

if (argv.build) {
    const cacheFromImage =
        argv.cacheFromVersion &&
        getRepository() + getName() + ":" + argv.cacheFromVersion;

    if (cacheFromImage) {
        // Pull this image into the docker daemon - if it fails we don't care, we'll just go from scratch.
        const dockerPullProcess = childProcess.spawnSync(
            "docker",
            [...extraParameters, "pull", cacheFromImage],
            {
                stdio: "inherit",
                env: env
            }
        );
        wrapConsoleOutput(dockerPullProcess);
    }

    const tarProcess = childProcess.spawn(
        tar,
        [...extraParameters, "--dereference", "-czf", "-", "*"],
        {
            cwd: dockerContextDir,
            stdio: ["inherit", "pipe", "inherit"],
            env: env,
            shell: true
        }
    );
    const tags = getTags();
    const tagArgs = tags
        .map(tag => ["-t", tag])
        .reduce((soFar, tagArgs) => soFar.concat(tagArgs), []);

    const cacheFromArgs = cacheFromImage
        ? ["--cache-from", cacheFromImage]
        : [];

    const dockerProcess = childProcess.spawn(
        "docker",
        [
            ...extraParameters,
            "build",
            ...tagArgs,
            ...cacheFromArgs,
            "-f",
            `./component/Dockerfile`,
            "-"
        ],
        {
            stdio: ["pipe", "inherit", "inherit"],
            env: env
        }
    );

    wrapConsoleOutput(dockerProcess);

    dockerProcess.on("close", code => {
        fse.removeSync(dockerContextDir);

        if (code === 0 && argv.push) {
            if (tags.length === 0) {
                console.error("Can not push an image without a tag.");
                process.exit(1);
            }

            // Stop if there's a code !== 0
            tags.every(tag => {
                const process = childProcess.spawnSync(
                    "docker",
                    ["push", tag],
                    {
                        stdio: "inherit"
                    }
                );

                code = process.status;

                return code === 0;
            });
        }
        process.exit(code);
    });

    tarProcess.on("close", code => {
        dockerProcess.stdin.end();
    });

    tarProcess.stdout.on("data", data => {
        dockerProcess.stdin.write(data);
    });
} else if (argv.output) {
    const outputPath = path.resolve(process.cwd(), argv.output);
    console.log(outputPath);

    const outputTar = fse.openSync(outputPath, "w", 0o644);

    const tarProcess = childProcess.spawn(
        tar,
        ["--dereference", "-czf", "-", "*"],
        {
            cwd: dockerContextDir,
            stdio: ["inherit", outputTar, "inherit"],
            env: env,
            shell: true
        }
    );

    tarProcess.on("close", code => {
        fse.closeSync(outputTar);
        console.log(tarProcess.status);
        fse.removeSync(dockerContextDir);
    });
}

function getVersions() {
    return (
        argv.version || [
            !argv.local && process.env.npm_package_version
                ? process.env.npm_package_version
                : "latest"
        ]
    );
}

function getName() {
    return process.env.npm_package_config_docker_name
        ? process.env.npm_package_config_docker_name
        : process.env.npm_package_name
            ? process.env.npm_package_name
            : "UnnamedImage";
}

function getTags() {
    if (argv.tag === "auto") {
        return getVersions().map(version => {
            const tagPrefix = getRepository();
            const name = getName();

            return (tag = tagPrefix + name + ":" + version);
        });
    } else {
        return argv.tag ? [argv.tag] : [];
    }
}

function getRepository() {
    return (
        (argv.repository && argv.repository + "/") ||
        (argv.local ? "localhost:5000/" : "")
    );
}

function updateDockerFile(sourceDir, destDir) {
    const tags = getVersions();
    const repository = getRepository();
    const dockerFileContents = fse.readFileSync(
        path.resolve(sourceDir, "Dockerfile"),
        "utf-8"
    );
    const replacedDockerFileContents = dockerFileContents
        // Add a repository if this is a magda image
        .replace(/FROM (.*magda-.*)(\s|$)/, "FROM " + repository + "$1$2")
        // Add a tag if none specified
        .replace(
            /FROM (.+\/[^:\s]+)(\s|$)/,
            "FROM $1" + (tags[0] ? ":" + tags[0] : "") + "$2"
        );

    fse.writeFileSync(
        path.resolve(destDir, "Dockerfile"),
        replacedDockerFileContents,
        "utf-8"
    );
}

function preparePackage(packageDir, destDir) {
    const packageJson = require(path.join(packageDir, "package.json"));
    const dockerIncludesFromPackageJson =
        packageJson.config &&
        packageJson.config.docker &&
        packageJson.config.docker.include;

    let dockerIncludes;
    if (!dockerIncludesFromPackageJson) {
        console.log(
            `WARNING: Package ${packageDir} does not have a config.docker.include key in package.json, so all of its files will be included in the docker image.`
        );
        dockerIncludes = fse.readdirSync(packageDir);
    } else if (dockerIncludesFromPackageJson.trim() === "*") {
        dockerIncludes = fse.readdirSync(packageDir);
    } else {
        if (dockerIncludesFromPackageJson.indexOf("*") >= 0) {
            throw new Error(
                "Sorry, wildcards are not currently supported in config.docker.include."
            );
        }
        dockerIncludes = dockerIncludesFromPackageJson
            .split(" ")
            .filter(include => include.length > 0);
    }

    dockerIncludes
        .filter(include => include !== "Dockerfile") // Filter out the dockerfile because we'll manually copy over a modified version.
        .forEach(function(include) {
            const src = path.resolve(packageDir, include);
            const dest = path.resolve(destDir, include);

            if (include === "node_modules") {
                fse.ensureDirSync(dest);

                // Get the list of production packages required by this package.
                const productionPackageResult = JSON.parse(
                    childProcess.spawnSync(
                        "npm",
                        ["list", "--prod", "--json"],
                        {
                            encoding: "utf8",
                            cwd: packageDir,
                            shell: true
                        }
                    ).stdout
                );
                const productionPackages = getPackageList(
                    productionPackageResult.dependencies,
                    path.join(packageDir, "node_modules"),
                    []
                );

                prepareNodeModules(src, dest, productionPackages);
                return;
            }

            const type = fse.statSync(src).isFile() ? "file" : "junction";

            // On Windows we can't create symlinks to files without special permissions.
            // So just copy the file instead.  Usually creating directory junctions is
            // fine without special permissions, but fall back on copying in the unlikely
            // event that fails, too.
            try {
                fse.ensureSymlinkSync(src, dest, type);
            } catch (e) {
                fse.copySync(src, dest);
            }
        });
}

function prepareNodeModules(packageDir, destDir, productionPackages) {
    const subPackages = fse.readdirSync(packageDir);
    subPackages.forEach(function(subPackageName) {
        const src = path.join(packageDir, subPackageName);
        const dest = path.join(destDir, subPackageName);

        if (subPackageName[0] === "@") {
            // This is a scope directory, recurse.
            fse.ensureDirSync(dest);
            prepareNodeModules(src, dest, productionPackages);
            return;
        }

        if (productionPackages.indexOf(src) == -1) {
            // Not a production dependency, skip it.
            return;
        }

        const stat = fse.lstatSync(src);
        if (stat.isSymbolicLink()) {
            // This is a link to another package, presumably created by Lerna.
            fse.ensureDirSync(dest);
            preparePackage(src, dest);
            return;
        }

        // Regular package, link/copy the whole thing.
        try {
            const type = stat.isFile() ? "file" : "junction";
            fse.ensureSymlinkSync(src, dest, type);
        } catch (e) {
            fse.copySync(src, dest);
        }
    });
}

function getPackageList(dependencies, basePath, result) {
    if (!dependencies) {
        return result;
    }

    Object.keys(dependencies).forEach(function(dependencyName) {
        const dependencyDetails = dependencies[dependencyName];
        if (dependencyDetails.extraneous) {
            return;
        }

        let dependencyDir = path.join(
            basePath,
            dependencyName.replace(/\//g, path.sep)
        );

        // Does this directory exist?  If not, imitate node's module resolution by walking
        // up the directory tree.
        while (!fse.existsSync(dependencyDir)) {
            const upOne = path.resolve(
                dependencyDir,
                "..",
                "..",
                "..",
                "node_modules",
                path.basename(dependencyDir)
            );
            if (upOne === dependencyDir) {
                break;
            }
            dependencyDir = upOne;
        }

        result.push(dependencyDir);

        if (dependencyDetails.dependencies) {
            getPackageList(
                dependencyDetails.dependencies,
                path.join(dependencyDir, "node_modules"),
                result
            );
        }
    });

    return result;
}

function wrapConsoleOutput(process) {
    if (process.stdout) {
        process.stdout.on("data", data => {
            console.log(data.toString());
        });
    }
    if (process.stderr) {
        process.stderr.on("data", data => {
            console.error(data.toString());
        });
    }
}
