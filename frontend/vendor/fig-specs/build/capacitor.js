//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/capacitor.ts
var platforms = [{
	name: "android",
	icon: "fig://icon?type=android"
}, {
	name: "ios",
	icon: "fig://icon?type=apple"
}];
function isPlatform(value) {
	return value === "ios" || value === "android";
}
var completionSpec = {
	name: "capacitor",
	description: "The Capacitor command-line interface (CLI) tool is used to develop Capacitor apps",
	icon: "https://capacitorjs.com/docs/img/meta/favicon.png",
	subcommands: [
		{
			name: "add",
			description: "Add a native platform project to your app",
			args: {
				name: "platform",
				suggestions: platforms
			}
		},
		{
			name: "copy",
			description: "Copy the web app build and Capacitor configuration file into the native platform project. Run this each time you make changes to your web app or change a configuration value",
			priority: 51,
			args: {
				name: "platform",
				suggestions: platforms,
				isOptional: true
			}
		},
		{
			name: "ls",
			description: "List all installed Cordova and Capacitor plugins",
			args: {
				name: "platform",
				suggestions: platforms,
				isOptional: true
			}
		},
		{
			name: "open",
			description: "Opens the native project workspace in the specified native IDE (Xcode for iOS, Android Studio for Android)",
			priority: 51,
			args: {
				name: "platform",
				suggestions: platforms
			}
		},
		{
			name: "run",
			description: "Opens the native project workspace in the specified native IDE (Xcode for iOS, Android Studio for Android)",
			priority: 51,
			args: {
				name: "platform",
				suggestions: platforms
			},
			options: [{
				name: "--list",
				description: "Print a list of target devices available to the given platform",
				icon: "📱"
			}, {
				name: "--target",
				description: "Run on a specific target device",
				icon: "📱",
				args: {
					name: "target",
					generators: {
						cache: { ttl: 6e4 },
						custom: async (tokens, executeShellCommand) => {
							const [cliName, command, platform] = tokens;
							if (!isPlatform(platform)) return [];
							const { stdout } = await executeShellCommand({
								command: "npx",
								args: [
									"capacitor",
									"run",
									platform,
									"--list"
								]
							});
							return stdout.trim().split("\n").slice(2).map((s) => {
								const [name, api, targetId] = s.replace(/\s\s+/g, "|").split("|");
								return {
									name: targetId,
									displayName: `${name} ${api}`,
									icon: "📱"
								};
							});
						}
					}
				}
			}]
		},
		{
			name: "sync",
			description: "This command runs copy and then update",
			args: {
				name: "platform",
				suggestions: platforms,
				isOptional: true
			},
			options: [{
				name: "--deployment",
				description: "Podfile.lock won't be deleted and pod install will use --deployment option"
			}, {
				name: "--inline",
				description: "After syncing, all JS source maps will be inlined allowing for debugging an Android Web View in Chromium based browsers"
			}]
		},
		{
			name: "update",
			description: "Updates the native plugins and dependencies referenced in package.json",
			args: {
				name: "platform",
				suggestions: platforms,
				isOptional: true
			},
			options: [{
				name: "--deployment",
				description: "Podfile.lock won't be deleted and pod install will use --deployment option"
			}]
		}
	],
	options: [{
		name: ["--help", "-h"],
		description: "Output usage information. Can be used with individual commands too",
		isPersistent: true
	}, {
		name: ["--version", "-V"],
		description: "Output the version number"
	}]
};
//#endregion
export { completionSpec as default };
