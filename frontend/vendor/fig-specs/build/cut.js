//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/cut.ts
var completionSpec = {
	name: "cut",
	description: "Cut out selected portions of each line of a file",
	args: {
		template: "filepaths",
		isOptional: true,
		isVariadic: true
	},
	options: [
		{
			name: "-b",
			description: "Byte positions as a comma or - separated list of numbers",
			args: {
				name: "list",
				description: "Specifies byte positions"
			}
		},
		{
			name: "-c",
			description: "Column positions as a comma or - separated list of numbers",
			args: {
				name: "list",
				description: "Specifies column positions"
			}
		},
		{
			name: "-f",
			description: "Field positions as a comma or - separated list of numbers",
			args: {
				name: "list",
				description: "Specifies column positions"
			}
		},
		{
			name: "-n",
			description: "Do not split multi-byte characters"
		},
		{
			name: "-d",
			description: "Use delim as the field delimiter character instead of the tab character",
			args: {
				name: "delim",
				description: "Field deliminator to use instead of the tab character",
				isOptional: true
			}
		},
		{
			name: "-s",
			description: "Suppress lines with no field delimiter characters.  unless specified, lines with no delimiters are passed through unmodified"
		},
		{
			name: "-w",
			description: "Use whitespace (spaces and tabs) as the delimiter.  Consecutive spaces and tabs count as one single field separator"
		}
	]
};
//#endregion
export { completionSpec as default };
