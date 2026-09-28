//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/heroku/shared.ts
var getAppGenerator = {
	script: [
		"heroku",
		"apps",
		"--all",
		"--json"
	],
	cache: { strategy: "stale-while-revalidate" },
	scriptTimeout: 15e3,
	postProcess: function(out) {
		try {
			return JSON.parse(out).map((app) => {
				return {
					name: app.name,
					description: app.name,
					icon: "https://www.herokucdn.com/favicon.ico"
				};
			});
		} catch (e) {
			return [];
		}
	}
};
var shared_default = {};
//#endregion
export { shared_default as default, getAppGenerator };
