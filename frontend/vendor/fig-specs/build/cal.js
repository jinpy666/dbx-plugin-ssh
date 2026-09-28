//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/ncal.ts
var monthSuggestions = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december"
].map((month) => ({
	name: month,
	icon: "🗓",
	type: "arg"
}));
[
	["AL", "Albania"],
	["AT", "Austria"],
	["AU", "Australia"],
	["BE", "Belgium"],
	["BG", "Bulgaria"],
	["CA", "Canada"],
	["CH", "Switzerland"],
	["CN", "China"],
	["CZ", "Czech Republic"],
	["DE", "Germany"],
	["DK", "Denmark"],
	["ES", "Spain"],
	["FI", "Finland"],
	["FR", "France"],
	["GB", "United Kingdom"],
	["GR", "Greece"],
	["HU", "Hungary"],
	["IS", "Iceland"],
	["IT", "Italy"],
	["JP", "Japan"],
	["LI", "Lithuania"],
	["LN", "Latin"],
	["LU", "Luxembourg"],
	["LV", "Latvia"],
	["NL", "Netherlands"],
	["NO", "Norway"],
	["PL", "Poland"],
	["PT", "Portugal"],
	["RO", "Romania"],
	["RU", "Russia"],
	["SI", "Slovenia"],
	["SW", "Sweden"],
	["TR", "Turkey"],
	["US", "United States"],
	["YU", "Yugoslavia"]
].map((country) => ({
	name: country[0],
	description: country[1],
	icon: "🌎",
	type: "arg"
}));
//#endregion
//#region ../../../../../../private/var/folders/4_/zmg595750zv57pwjdvllgrtc0000gn/T/dbx-fig-sync/fig-autocomplete-aef52acff84c/src/cal.ts
var completionSpec = {
	name: "cal",
	parserDirectives: { optionsMustPrecedeArguments: true },
	description: "Displays a calendar and the date of Easter",
	args: {
		name: "year",
		description: "Year to print calendar of"
	},
	options: [
		{
			name: "-h",
			description: "Turns off highlighting of today"
		},
		{
			name: "-j",
			description: "Display Julian days (days one-based, numbered from January 1)"
		},
		{
			name: "-m",
			description: "Display the specified month.  If month is specified as a decimal number, it may be followed by the letter ‘f’ or ‘p’ to indicate the following or preceding month of that number, respectively",
			exclusiveOn: ["-y"],
			args: {
				name: "month",
				suggestions: monthSuggestions
			}
		},
		{
			name: "-y",
			description: "Display a calendar for the specified year",
			exclusiveOn: ["-m"]
		}
	]
};
//#endregion
export { completionSpec as default };
