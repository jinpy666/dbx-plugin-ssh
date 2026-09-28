//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/mask.ts
var completionSpec = {
	name: "mask",
	generateSpec: async (tokens, executeShellCommand) => {
		var maskfileLocationIdx = tokens.indexOf("--maskfile");
		var out;
		if (maskfileLocationIdx < 0 || maskfileLocationIdx + 3 > tokens.length) {
			const { stdout } = await executeShellCommand({
				command: "cat",
				args: ["maskfile.md"]
			});
			out = stdout;
		} else {
			const { stdout } = await executeShellCommand({
				command: "cat",
				args: [tokens[maskfileLocationIdx + 1]]
			});
			out = stdout;
		}
		if (out === "") return { name: "null" };
		return {
			name: "mask",
			subcommands: out.match(/##.*/g).map((elm) => {
				return { name: elm.slice(3) };
			})
		};
	}
};
//#endregion
export { completionSpec as default };
