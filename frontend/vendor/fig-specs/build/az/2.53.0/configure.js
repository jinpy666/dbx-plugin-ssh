//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/az/2.53.0/configure.ts
var completion = {
	name: "configure",
	description: "Manage Azure CLI configuration. This command is interactive",
	options: [
		{
			name: ["--defaults", "-d"],
			description: "Space-separated 'name=value' pairs for common argument defaults",
			args: { name: "defaults" }
		},
		{
			name: ["--list-defaults", "-l"],
			description: "List all applicable defaults",
			args: {
				name: "list-defaults",
				suggestions: ["false", "true"]
			}
		},
		{
			name: "--scope",
			description: "Scope of defaults. Using \"local\" for settings only effective under current folder",
			args: {
				name: "scope",
				suggestions: ["global", "local"]
			}
		}
	]
};
//#endregion
export { completion as default };
