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
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ni.ts
var completionSpec = {
	name: "ni",
	description: "Use the right package manager - install",
	options: [
		{
			name: "-g",
			description: "Operates in 'global' mode, so that packages are installed into the prefix folder instead of the current working directory"
		},
		{
			name: "-D",
			description: "Package will appear in your `devDependencies`"
		},
		{
			name: "-P",
			description: "Save package to your `peerDependencies`"
		},
		{
			name: "-O",
			description: "Save package to your `optionalDependencies`"
		},
		{
			name: "--frozen",
			description: "Don't generate a lockfile and fail if an update is needed"
		},
		{
			name: "-C",
			description: "Change directory",
			args: [{
				name: "directory",
				description: "The directory to move",
				template: "folders"
			}, {
				name: "target",
				description: "The target directory",
				template: "folders"
			}]
		},
		{
			name: ["-h", "--help"],
			description: "Output usage information"
		}
	],
	args: {
		name: "package",
		generators: npmSearchGenerator,
		debounce: true,
		isVariadic: true
	}
};
//#endregion
export { completionSpec as default };
