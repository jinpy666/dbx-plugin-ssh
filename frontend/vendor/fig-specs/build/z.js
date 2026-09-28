//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/z.ts
async function getZHistory(execute) {
	const { stdout } = await execute({
		command: "zsh",
		args: ["-c", "cat ${${ZSHZ_DATA:-${_Z_DATA:-${HOME}/.z}}:A}"]
	});
	return stdout.split("\n").map((line) => {
		const [path, weight, time] = line.split("|");
		const splitPath = path.split("/");
		return {
			name: splitPath[splitPath.length - 1],
			path,
			weight: 75 + Number(weight) * 25 / 9e3,
			time: Number(time)
		};
	});
}
async function getCurrentDirectoryFolders(currentWorkingDirectory, execute) {
	const { stdout } = await execute({
		command: "bash",
		args: ["-c", "ls -d */"]
	});
	return stdout.split("\n").map((line) => {
		const name = line.replace("/", "");
		return {
			name,
			path: `${currentWorkingDirectory}/${name}`
		};
	});
}
function filterHistoryBySearchTerms(insertedTerms, history) {
	const insertedTermsMap = new Set(insertedTerms);
	return history.filter(({ name, path }) => !insertedTermsMap.has(name) && insertedTerms.every((item) => path.includes(item)));
}
var zShCompletionSpec = {
	name: "z",
	description: "CLI tool to jump around directories",
	args: {
		name: "directory",
		isVariadic: true,
		isOptional: true,
		generators: { custom: async (tokens, execute, context) => {
			const { currentWorkingDirectory } = context;
			const [zHistory, currentFolders] = await Promise.all([getZHistory(execute), getCurrentDirectoryFolders(currentWorkingDirectory, execute)]);
			const suggestions = [...zHistory, ...currentFolders].reduce((acc, suggestion) => {
				if (!acc.some(({ path }) => path === suggestion.path)) acc.push(suggestion);
				return acc;
			}, []);
			return filterHistoryBySearchTerms(tokens.filter((arg) => arg && arg !== "z" && !arg.startsWith("-")), suggestions).map((point) => ({
				name: point.name,
				icon: "📁",
				description: point.path,
				priority: point.weight,
				insertValue: point.name,
				displayName: point.name
			}));
		} }
	},
	options: [
		{
			name: "-c",
			description: "Restrict matches to subdirectories of the current directory"
		},
		{
			name: "-e",
			description: "Echo the best match, don't cd"
		},
		{
			name: "-h",
			description: "Show a brief help message"
		},
		{
			name: "-l",
			description: "List only"
		},
		{
			name: "-r",
			description: "Match by rank only"
		},
		{
			name: "-t",
			description: "Match by recent access only"
		},
		{
			name: "-x",
			description: "Remove the current directory from the datafile"
		}
	]
};
var zoxideCompletionSpec = {
	name: "z",
	description: "Smarter cd command, inspired by z and autojump",
	args: {
		name: "directory",
		filterStrategy: "fuzzy",
		suggestCurrentToken: true,
		generators: {
			custom: async (tokens, executeShellCommand, { currentWorkingDirectory }) => {
				let args;
				if (tokens.length < 2 || tokens[1] === "") args = [
					"query",
					"--list",
					"--score"
				];
				else args = [
					"query",
					"--list",
					"--score",
					"--",
					tokens.slice(1).join(" ")
				];
				const { stdout } = await executeShellCommand({
					command: "zoxide",
					args
				});
				const zoxideFolders = stdout.split("\n").map((line) => {
					const trimmedLine = line.trim();
					const spaceIndex = trimmedLine.indexOf(" ");
					const score = Number(trimmedLine.slice(0, spaceIndex));
					const fullPath = trimmedLine.slice(spaceIndex + 1);
					const pathSplit = fullPath.split("/");
					const parentFullPath = pathSplit.slice(0, pathSplit.length - 1).join("/");
					const folderName = pathSplit.at(-1);
					const folderIsInCwd = currentWorkingDirectory === parentFullPath;
					return {
						name: folderIsInCwd ? folderName : fullPath,
						description: `Score: ${score}`,
						icon: "💾",
						path: fullPath,
						priority: folderIsInCwd ? 9e3 : score
					};
				});
				const cwdFolders = (await getCurrentDirectoryFolders(currentWorkingDirectory, executeShellCommand)).map(({ name, path }) => ({
					name,
					description: "Score: 0",
					icon: "📁",
					path,
					priority: 8999
				}));
				return [...zoxideFolders, ...cwdFolders].reduce((acc, folder) => {
					if (!acc.some(({ path }) => path === folder.path)) acc.push(folder);
					return acc;
				}, []);
			},
			trigger: { on: "change" }
		}
	}
};
var zCompletionSpec = {
	name: "z",
	generateSpec: async (_, executeShellCommand) => {
		try {
			const { status } = await executeShellCommand({
				command: "bash",
				args: ["-c", "command -v zoxide"]
			});
			if (status === 0) return zoxideCompletionSpec;
		} catch (_) {}
		return zShCompletionSpec;
	}
};
//#endregion
export { zCompletionSpec as default };
