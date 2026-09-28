//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/base64.ts
var completionSpec = {
	name: "base64",
	description: "Encode and decode using Base64 representation",
	parserDirectives: { optionsMustPrecedeArguments: true },
	options: [
		{
			name: ["--help", "-h"],
			description: "Display this help and exit"
		},
		{
			name: ["--break", "-b"],
			description: "Insert line breaks every count characters.  Default is 0, which generates an unbroken stream",
			args: {
				name: "count",
				suggestions: ["0"],
				default: "0"
			}
		},
		{
			name: [
				"--decode",
				"-d",
				"-D"
			],
			description: "Decode incoming Base64 stream into binary data"
		},
		{
			name: ["--input", "-i"],
			description: "Read input from input_file.  Default is stdin; passing - also represents stdin",
			args: {
				name: "input_file",
				suggestions: ["stdin", "-"],
				default: "stdin",
				template: "filepaths"
			}
		},
		{
			name: ["--output", "-o"],
			description: "Write output to output_file.  Default is stdout; passing - also represents stdout",
			args: {
				name: "output_file",
				suggestions: ["stdout", "-"],
				default: "stdout",
				template: "filepaths"
			}
		}
	]
};
//#endregion
export { completionSpec as default };
