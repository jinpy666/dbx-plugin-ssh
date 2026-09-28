var atsInStr = (s) => (s.match(/@/g) || []).length;
var createNpmSearchHandler = (keywords) => async (context, executeShellCommand, shellContext) => {
	const searchTerm = context[context.length - 1];
	if (searchTerm === "") return [];
	const keywordParameter = keywords && keywords.length > 0 ? `+keywords:${keywords.join(",")}` : "";
	const queryPackages = [
		"-s",
		"-H",
		"Accept: application/json",
		keywordParameter ? `https://api.npms.io/v2/search?size=20&q=${searchTerm}${keywordParameter}` : `https://api.npms.io/v2/search/suggestions?q=${searchTerm}&size=20`
	];
	const queryVersions = [
		"-s",
		"-H",
		"Accept: application/vnd.npm.install-v1+json",
		`https://registry.npmjs.org/${searchTerm.slice(0, -1)}`
	];
	const out = (query) => executeShellCommand({
		command: "curl",
		args: query[query.length - 1] === "@" ? queryVersions : queryPackages
	});
	const shouldGetVersion = searchTerm.startsWith("@") ? atsInStr(searchTerm) > 1 : searchTerm.includes("@");
	try {
		const data = JSON.parse((await out(searchTerm)).stdout);
		if (shouldGetVersion) {
			const versions = Object.entries(data["dist-tags"] || {}).map(([key, value]) => ({
				name: key,
				description: value
			}));
			versions.push(...Object.keys(data.versions).map((version) => ({ name: version })).reverse());
			return versions;
		}
		return (keywordParameter ? data.results : data).map((item) => ({
			name: item.package.name,
			description: item.package.description
		}));
	} catch (error) {
		console.error({ error });
		return [];
	}
};
var npmSearchGenerator = {
	trigger: (newToken, oldToken) => {
		if (oldToken.startsWith("@")) return !(atsInStr(oldToken) > 1 && atsInStr(newToken) > 1);
		return !(oldToken.includes("@") && newToken.includes("@"));
	},
	getQueryTerm: "@",
	cache: { ttl: 1728e5 },
	custom: createNpmSearchHandler()
};
var workSpaceOptions = [{
	name: ["-w", "--workspace"],
	description: "Enable running a command in the context of the configured workspaces of the current project",
	args: {
		name: "workspace",
		generators: { custom: async (tokens, executeShellCommand) => {
			const { stdout: npmPrefix } = await executeShellCommand({
				command: "npm",
				args: ["prefix"]
			});
			const { stdout: out } = await executeShellCommand({
				command: "cat",
				args: [`${npmPrefix}/package.json`]
			});
			const suggestions = [];
			try {
				if (out.trim() == "") return suggestions;
				const workspaces = JSON.parse(out)["workspaces"];
				if (workspaces) for (const workspace of workspaces) suggestions.push({
					name: workspace,
					description: "Workspaces"
				});
			} catch (e) {
				console.log(e);
			}
			return suggestions;
		} },
		isVariadic: true
	}
}, {
	name: ["-ws", "--workspaces"],
	description: "Enable running a command in the context of all the configured workspaces"
}];
[...workSpaceOptions];
[...workSpaceOptions];
[...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions], [...workSpaceOptions];
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/mgnl.ts
var pathOption = (description) => ({
	name: ["-p", "--path"],
	description,
	args: {
		name: "path",
		template: "folders"
	}
});
var prototypeOption = (description) => ({
	name: ["-P", "--prototype"],
	description,
	args: { name: "prototype" }
});
var lightModuleGenerator = {
	...npmSearchGenerator,
	custom: createNpmSearchHandler(["magnolia-light-module"])
};
var completionSpec = {
	name: "mgnl",
	description: "Magnolia CLI is a command line interface (CLI) tool to set up and facilitate light development with Magnolia",
	icon: "https://avatars.githubusercontent.com/u/25686615?s=200&v=4",
	subcommands: [
		{
			name: "add-availability",
			description: "This command makes a component available to a page",
			args: [{
				name: "<[module-id:]path-to-component>",
				description: "The component you want to make available"
			}, {
				name: "<path-to-page[@area]>",
				description: "The page you want to make the component available to"
			}],
			options: [pathOption("The path to the light module that contains the page template"), {
				name: "-g",
				description: "Add this parameter to autogenerate the component instead of providing plain availability"
			}]
		},
		{
			name: "create-app",
			description: "This command creates a content type and an app",
			args: {
				name: "name",
				description: "The name of the new app. The name cannot contain spaces"
			},
			options: [pathOption("The path to the light module where you want to create the app"), prototypeOption("The name of the prototype variant to create the app")]
		},
		{
			name: "create-block",
			description: "This command creates a block",
			args: {
				name: "blockName",
				description: "The name of the new block definition. The block name cannot contain spaces"
			},
			options: [pathOption("The path to the light module to add the new block to"), prototypeOption("The name of the prototype variant to create the block")]
		},
		{
			name: "create-component",
			description: "This command creates a new component template",
			args: {
				name: "name",
				description: "The name of the new component template. The name cannot contain spaces"
			},
			options: [
				pathOption("The path to the light module you want to add the component template to"),
				{
					name: ["-a", "--available"],
					description: "The page you want to make the component available to",
					args: { name: "<path-to-page[@area]>" }
				},
				{
					name: ["-g", "--autogenerate"],
					description: "Add this parameter to autogenerate the component instead of providing plain availability",
					args: { name: "<path-to-page[@area]>" }
				},
				prototypeOption("The name of the prototype variant to create the component")
			]
		},
		{
			name: "create-content-type",
			description: "This command creates a content type",
			args: {
				name: "name",
				description: "The name of the new content type. The name cannot contain spaces"
			},
			options: [
				{
					name: "-a",
					description: "Creates also a new app that references the content type. With the -a option, the command is functionally equivalent to the create-app command"
				},
				pathOption("The path to the light module where you want to create the content type"),
				prototypeOption("The name of the prototype variant to create the content type")
			]
		},
		{
			name: "create-light-module",
			description: "This command creates a new light module in the form of a set of empty light module folders",
			args: {
				name: "moduleName",
				description: "The name of the new light module. Avoid spaces and special characters since this name is used as folder name"
			},
			options: [pathOption("The path of the parent directory for the new light module"), prototypeOption("The name of the prototype variant to create the light module")]
		},
		{
			name: "create-page",
			description: "This command creates a new page template",
			args: {
				name: "templateName",
				description: "The name of the new page template. The template name cannot contain spaces"
			},
			options: [pathOption("The path to the light module to add the new template to"), prototypeOption("The name of the prototype variant to create the page")]
		},
		{
			name: "create-virtual-uri",
			description: "The command creates a virtual URI mapping configuration file (a YAML definition file) in the light module",
			args: {
				name: "virtualUriName",
				description: "The name of the new URI configuration"
			},
			options: [
				pathOption("The path to the light module"),
				{
					name: ["-f", "--formUri"],
					description: "The pattern to be matched in the requested URI. Enclose the <uri> value in quotes",
					args: { name: "uri" }
				},
				{
					name: ["-t", "--toUri"],
					description: "A concrete URI that the request is mapped to. Enclose the <prefix:uri> value in quotes",
					args: { name: "<prefix:uri>" }
				},
				prototypeOption("The name of the prototype variant to create the mapping")
			]
		},
		{
			name: "customize-local-config",
			description: "Run this command to create a local configuration",
			options: [pathOption("The path into which the mgnl-cli-prototypes folder and mgnl-cli.json file are installed")]
		},
		{
			name: "install",
			description: "Downloads and installs one or more light modules from npm to the light module directory",
			args: {
				name: "light-module-name",
				description: "At least one name of a light module to be downloaded from npm. If you are installing more than one module from the repository, separate the module names with a space",
				isVariadic: true,
				debounce: true,
				generators: lightModuleGenerator
			},
			options: [pathOption("The path to the light-modules folder")]
		},
		{
			name: "jumpstart",
			description: "This command downloads, unpacks and pre-configures a Magnolia Tomcat server together with a specific webapp",
			options: [
				pathOption("The path to the light modules root folder which is observed for changes"),
				{
					name: ["-m", "--magnolia-version"],
					description: "Use to choose a specific version of the Magnolia webapp. If not provided, the latest stable version of the specified webapp is downloaded",
					args: { name: "version" }
				},
				{
					name: ["-i", "--install-sample-module"],
					description: "If provided, a sample light module under the light modules root folder with the given name is created",
					args: { name: "name" }
				},
				{
					name: ["-s", "--snapshot"],
					description: "Downloads the latest snapshot development version of the specified webapp"
				},
				{
					name: ["-w", "--webapp"],
					description: "Use to directly specify which Magnolia webapp you want to install",
					args: {
						name: "webapp",
						suggestions: [
							{ name: "magnolia-empty-webapp" },
							{ name: "magnolia-community-webapp" },
							{ name: "magnolia-community-demo-webapp" },
							{ name: "magnolia-dx-core-webapp" },
							{ name: "magnolia-dx-core-demo-webapp" }
						]
					}
				}
			]
		},
		{
			name: "tab-completion",
			description: "Run the command to install or uninstall autocompletion for Magnolia CLI commands",
			args: {
				name: "command",
				suggestions: [{ name: "install" }, { name: "uninstall" }]
			}
		},
		{
			name: "search",
			description: "Searches for Magnolia-related packages available from npm",
			args: {
				name: "query",
				generators: lightModuleGenerator,
				description: "The search query sent to the npm's API. The query can contain multiple terms separated with commas and no spaces"
			}
		},
		{
			name: "start",
			description: "This command starts up Magnolia and displays the main log file",
			options: [pathOption("The path to the apache-tomcat folder"), {
				name: "-d",
				description: "Does NOT ignore the open files limit check. The files limit check is ignored by default"
			}]
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Show help for mgnl",
		isPersistent: true
	}]
};
//#endregion
export { completionSpec as default };
