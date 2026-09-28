//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/where.ts
var completionSpec = {
	name: "where",
	description: "For each name, indicate how it should be interpreted",
	args: {
		name: "names",
		isVariadic: true
	},
	options: [
		{
			name: "-w",
			description: "For each name, print 'name: word', where 'word' is the kind of command"
		},
		{
			name: "-p",
			description: "Do a path search for the name, even if it's an alias/function/builtin"
		},
		{
			name: "-m",
			description: "The arguments are taken as patterns (pattern characters must be quoted)"
		},
		{
			name: "-s",
			description: "If the pathname contains symlinks, print the symlink-free name as well"
		},
		{
			name: "-S",
			description: "Print intermediate symlinks and the resolved name"
		},
		{
			name: "-x",
			description: "Expand tabs when outputting shell function",
			args: { name: "num" }
		}
	]
};
//#endregion
export { completionSpec as default };
