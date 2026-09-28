//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/defaultbrowser.ts
var completionSpec = {
	name: "defaultbrowser",
	description: "Change your default browser from the CLI",
	args: {
		isOptional: true,
		generators: {
			script: ["defaultbrowser"],
			postProcess: function(out) {
				return out.split("\n").map((line) => {
					if (line.startsWith("*")) return {};
					return { name: line.trim() };
				});
			}
		}
	}
};
//#endregion
export { completionSpec as default };
