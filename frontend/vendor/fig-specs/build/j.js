//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/j.ts
var completionSpec = {
	name: "j",
	name: "autojump",
	description: "A faster way to navigate your filesystem",
	options: [
		{
			name: ["-h", "--help"],
			description: "Show the help message and exit"
		},
		{
			name: ["-a", "--add"],
			description: "Add path",
			args: {
				name: "directory",
				template: ["folders"]
			}
		},
		{
			name: ["-i", "--increase"],
			description: "Increase current directory weight",
			args: {
				name: "weight",
				isOptional: true
			}
		},
		{
			name: ["-d", "--decrease"],
			description: "Decrease current directory weight",
			args: {
				name: "weight",
				isOptional: true
			}
		},
		{
			name: "--complete",
			description: "Used for tab completion"
		},
		{
			name: "--purge",
			description: "Remove non-existent paths from database"
		},
		{
			name: ["-s", "--stat"],
			description: "Show database entries and their key weights"
		},
		{
			name: ["-v", "--version"],
			description: "Show version information"
		}
	],
	args: {
		name: "directory",
		description: "Directory to jump to",
		isVariadic: true,
		generators: { custom: async (tokens, executeCommand, context) => {
			const { stdout } = await executeCommand({
				command: "cat",
				args: [`${context.environmentVariables["HOME"]}/Library/autojump/autojump.txt`]
			});
			const lines = stdout.split("\n").map((line) => {
				const [weight, dir] = line.split("	");
				return {
					weight: Number(weight),
					dir
				};
			});
			const args = tokens.slice(1, tokens.length - 1);
			return lines.filter(({ dir }) => args.every((arg) => dir.includes(arg))).map(({ weight, dir }) => {
				const splitPath = dir.split("/");
				const name = splitPath[splitPath.length - 1];
				if (!args.includes(name)) return {
					name,
					description: dir,
					priority: 75 + weight
				};
			});
		} }
	}
};
//#endregion
export { completionSpec as default };
