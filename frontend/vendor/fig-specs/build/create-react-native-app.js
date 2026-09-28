//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/create-react-native-app.ts
var ICONS = {
	help: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/help.png",
	version: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/info.png",
	true: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/true.png",
	false: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/false.png",
	skip: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/skip.png",
	path: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/path.png",
	string: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/string.png",
	template: "https://raw.githubusercontent.com/expo/expo-cli/master/assets/fig/export.png",
	npm: "fig://icon?type=npm"
};
var boolArg = {
	name: "boolean",
	isOptional: true,
	suggestions: [{
		name: "true",
		icon: ICONS.true
	}, {
		name: "false",
		icon: ICONS.false
	}]
};
var completionSpec = {
	name: "create-react-native-app",
	description: "Creates a new React Native project",
	args: {
		template: "folders",
		name: "name"
	},
	options: [
		{
			name: "--template",
			description: "The name of a template from expo/examples or URL to a GitHub repo that contains an example",
			args: { name: "template" },
			icon: ICONS.template,
			priority: 76
		},
		{
			name: "--template-path",
			description: "The path inside of a GitHub repo where the example lives",
			args: { name: "name" },
			icon: ICONS.path,
			priority: 76
		},
		{
			name: "--yes",
			description: "Use the default options for creating a project",
			args: boolArg,
			icon: ICONS.skip,
			priority: 76
		},
		{
			name: "--no-install",
			description: "Skip installing npm packages or CocoaPods",
			args: boolArg,
			icon: ICONS.skip,
			priority: 76
		},
		{
			name: "--use-npm",
			description: "Use npm to install dependencies. (default when Yarn is not installed)",
			args: boolArg,
			icon: ICONS.npm,
			priority: 76
		},
		{
			name: ["-h", "--help"],
			description: "Output usage information",
			icon: ICONS.help,
			priority: 1
		},
		{
			name: ["-V", "--version"],
			description: "Output the version number",
			icon: ICONS.version,
			priority: 1
		}
	]
};
//#endregion
export { completionSpec as default };
