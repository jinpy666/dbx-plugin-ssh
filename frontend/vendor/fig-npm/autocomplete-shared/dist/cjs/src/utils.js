"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpecLocationSource = exports.makeArray = void 0;
function makeArray(object) {
    return Array.isArray(object) ? object : [object];
}
exports.makeArray = makeArray;
var SpecLocationSource;
(function (SpecLocationSource) {
    SpecLocationSource["GLOBAL"] = "global";
    SpecLocationSource["LOCAL"] = "local";
})(SpecLocationSource = exports.SpecLocationSource || (exports.SpecLocationSource = {}));
//# sourceMappingURL=utils.js.map