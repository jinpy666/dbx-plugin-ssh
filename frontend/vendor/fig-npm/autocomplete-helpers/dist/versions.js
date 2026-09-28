var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import semver from "semver";
const isPrimitive = (obj) => obj !== Object(obj);
const deepEqual = (a, b) => {
    if (a === b)
        return true;
    if (isPrimitive(a) && isPrimitive(b))
        return a === b;
    if (Object.keys(a).length !== Object.keys(b).length)
        return false;
    for (const key in a) {
        if (!(typeof b === "object" && b && key in b && deepEqual(a[key], b[key]))) {
            return false;
        }
    }
    return true;
};
const diffSimpleObject = (original, updated) => {
    const diff = Object.assign({}, updated);
    for (const key in diff) {
        if (original &&
            typeof original === "object" &&
            key in original &&
            deepEqual(original[key], updated[key])) {
            delete diff[key];
        }
    }
    return diff;
};
const mergeSimpleObject = (original, diff) => (Object.assign(Object.assign({}, original), diff));
const toArray = (x) => {
    if (!x) {
        return [];
    }
    return Array.isArray(x) ? x : [x];
};
const namesMatch = (x, y) => {
    const xNames = new Set(toArray(x.name));
    return toArray(y.name).some((name) => xNames.has(name));
};
const isEmpty = (x) => x === undefined || x === null || Object.keys(x).length === 0;
const diffNamedArrays = (previous, updated, diffFn) => {
    const diffs = [];
    const matchedIndexes = new Set();
    updated.forEach((curr) => {
        const idx = previous.findIndex((prev, i) => !matchedIndexes.has(i) && namesMatch(curr, prev));
        if (idx === -1) {
            diffs.push(curr);
        }
        else {
            matchedIndexes.add(idx);
            const diff = diffFn(previous[idx], curr);
            if (diff !== null && Object.keys(diff).length > 0) {
                diffs.push(diff);
            }
        }
    });
    previous.forEach((prev, i) => {
        if (!matchedIndexes.has(i)) {
            diffs.push({ name: prev.name, remove: true });
        }
    });
    return diffs;
};
const mergeNamedArrayDiff = (current, diffs, mergeFn) => {
    const updated = [];
    const mergedIndexes = new Set();
    diffs.forEach((diff) => {
        const idx = current.findIndex((curr, i) => !mergedIndexes.has(i) && namesMatch(curr, diff));
        if (idx === -1) {
            updated.push(diff);
        }
        else {
            mergedIndexes.add(idx);
            if (!("remove" in diff)) {
                const merged = mergeFn(current[idx], diff);
                if (merged !== null) {
                    updated.push(merged);
                }
            }
        }
    });
    current.forEach((curr, i) => {
        if (!mergedIndexes.has(i)) {
            updated.push(curr);
        }
    });
    return updated;
};
const diffOrderedArrays = (previous, updated, diffFn) => {
    const diffs = [];
    updated.forEach((curr, idx) => {
        const diff = diffFn(previous[idx], curr);
        diffs.push(diff);
    });
    for (let i = diffs.length; i < previous.length; i += 1) {
        diffs.push({ remove: true });
    }
    return diffs.every((diff) => isEmpty(diff)) ? [] : diffs;
};
const mergeOrderedArrays = (current, diffs, mergeFn) => diffs
    .filter((diff) => !(typeof diff === "object" && diff && "remove" in diff) || !diff.remove)
    .map((diff, idx) => mergeFn(current[idx], diff))
    .filter((merged) => merged !== null);
const makeNamedProcessor = (propertyMapping) => ({
    diff: (previous, updated) => {
        var _a;
        const diff = Object.assign({}, updated);
        for (const key in diff) {
            if (key !== "name") {
                if (key in propertyMapping) {
                    delete diff[key];
                }
                else if (key in previous && deepEqual(previous[key], updated[key])) {
                    delete diff[key];
                }
            }
        }
        // eslint-disable-next-line guard-for-in
        for (const mapKey in propertyMapping) {
            // TODO: For some reason typescript can't infer the type well here...
            const key = mapKey;
            const propDiff = previous[key] && updated[key]
                ? (_a = propertyMapping[key]) === null || _a === void 0 ? void 0 : _a.diff(previous[key], updated[key])
                : updated[key];
            if (propDiff && !isEmpty(propDiff)) {
                diff[key] = propDiff;
            }
        }
        return Object.keys(diff).length === 1 ? null : diff;
    },
    merge: (current, diff) => {
        if (diff === null) {
            return current;
        }
        const merged = Object.assign(Object.assign({}, current), diff);
        // eslint-disable-next-line guard-for-in
        for (const mapKey in propertyMapping) {
            // TODO: For some reason typescript can't infer the type well here...
            const key = mapKey;
            const property = propertyMapping[key];
            if (diff[key] && property !== undefined) {
                merged[key] = property.merge(current[key], diff[key]);
            }
        }
        return merged;
    },
});
const argArrayProcessor = {
    diff: (p, u) => diffOrderedArrays(toArray(p), toArray(u), diffSimpleObject),
    merge: (c, d) => mergeOrderedArrays(toArray(c), toArray(d), mergeSimpleObject),
};
const optionProcessor = makeNamedProcessor({
    args: argArrayProcessor,
});
const subcommandProcessor = makeNamedProcessor({
    subcommands: {
        diff: (p, u) => diffNamedArrays(toArray(p), toArray(u), subcommandProcessor.diff),
        merge: (c, d) => mergeNamedArrayDiff(toArray(c), toArray(d), subcommandProcessor.merge),
    },
    options: {
        diff: (p, u) => diffNamedArrays(toArray(p), toArray(u), optionProcessor.diff),
        merge: (c, d) => mergeNamedArrayDiff(toArray(c), toArray(d), optionProcessor.merge),
    },
    args: argArrayProcessor,
});
const getBestVersionIndex = (versions, target) => {
    if (!target)
        return versions.length - 1;
    // find the last element minor or equal to the target
    for (let i = versions.length - 1; i >= 0; i -= 1) {
        const version = versions[i];
        if (semver.compare(version, target) <= 0) {
            return i;
        }
    }
    return versions.length - 1;
};
export const applySpecDiff = (spec, diff) => subcommandProcessor.merge(spec, Object.assign(Object.assign({}, diff), { name: spec.name }));
export const diffSpecs = (original, updated) => {
    const result = subcommandProcessor.diff(original, updated);
    if (result === null) {
        return {};
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { name: _name, remove: _remove } = result, remaining = __rest(result, ["name", "remove"]);
    return remaining;
};
export const getVersionFromVersionedSpec = (base, versions, target) => {
    const versionNames = Object.keys(versions).sort(semver.compare);
    const versionIndex = getBestVersionIndex(versionNames, target);
    const spec = versionNames
        .slice(0, versionIndex + 1)
        .map((name) => versions[name])
        .reduce(applySpecDiff, base);
    return { spec, version: versionNames[versionIndex] };
};
export const createVersionedSpec = (specName, versionFiles) => (version) => __awaiter(void 0, void 0, void 0, function* () {
    const versionNames = versionFiles.sort(semver.compare);
    const versionFileIndex = getBestVersionIndex(versionNames, version);
    const versionFile = versionNames[versionFileIndex];
    return {
        versionedSpecPath: `${specName}/${versionFile}`,
        version,
    };
});
//# sourceMappingURL=versions.js.map