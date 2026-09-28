//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/rbenv.ts
var installVersionsGenerator = {
	script: [
		"rbenv",
		"install",
		"-L"
	],
	postProcess: function(out) {
		return out.split("\n").map((name) => ({ name }));
	}
};
var installedVersionsGenerator = {
	script: [
		"rbenv",
		"versions",
		"--bare"
	],
	postProcess: function(out) {
		return out.split("\n").map((name) => ({ name }));
	}
};
var versionArg = (generator, required = false) => ({
	name: "version",
	isOptional: !required,
	generators: generator
});
var versionOptions = [{ name: "--unset" }];
var completionSpec = {
	name: "rbenv",
	description: "Pick a Ruby version for your application and guarantee that your development environment matches production",
	subcommands: [
		{
			name: "commands",
			description: "List all available rbenv commands",
			options: [{ name: "--sh" }, { name: "--no-sh" }]
		},
		{
			name: "global",
			description: "Set or show the global Ruby version",
			args: versionArg(installedVersionsGenerator),
			options: versionOptions
		},
		{
			name: "install",
			description: "Install a Ruby version using ruby-build",
			args: versionArg(installVersionsGenerator, true),
			options: [{
				name: "--version",
				description: "Show version of ruby-build",
				args: versionArg()
			}]
		},
		{
			name: "local",
			description: "Set or show the local application-specific Ruby version",
			args: versionArg(installedVersionsGenerator),
			options: versionOptions
		},
		{
			name: "rehash",
			description: "Rehash rbenv shims (run this after installing executables)"
		},
		{
			name: "shell",
			description: "Set or show the shell-specific Ruby version",
			args: versionArg(installedVersionsGenerator)
		},
		{
			name: "uninstall",
			description: "Uninstall a specific Ruby version",
			options: [{
				name: "-f",
				description: "If the version does not exist, do not display an error message",
				args: {}
			}]
		},
		{
			name: "versions",
			description: "List installed Ruby versions"
		},
		{
			name: "whence",
			description: "List all Ruby versions that contain the given executable"
		},
		{
			name: "which",
			description: "Display the full path to an executable",
			args: { name: "command" }
		}
	]
};
//#endregion
export { completionSpec as default };
