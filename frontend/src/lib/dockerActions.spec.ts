import { describe, expect, it } from "vitest";
import {
  confirmDockerAction,
  requestDockerAction,
  type DockerActionTarget,
} from "./dockerActions";

const target: DockerActionTarget = { id: "d4a7c9f1e2b3", name: "web" };

describe("Docker lifecycle confirmation state", () => {
  it("routes kill and rm through an explicit confirmation state", () => {
    for (const action of ["kill", "rm"] as const) {
      expect(requestDockerAction(target, action)).toEqual({
        confirmation: { ...target, action },
        dispatch: null,
      });
    }
  });

  it("dispatches reversible actions directly without showing confirmation", () => {
    for (const action of ["start", "stop", "restart"] as const) {
      expect(requestDockerAction(target, action)).toEqual({
        confirmation: null,
        dispatch: { id: target.id, action },
      });
    }
  });

  it("only dispatches a destructive action after confirmation and clears the pending target", () => {
    const pending = requestDockerAction(target, "kill").confirmation;
    expect(confirmDockerAction(pending, false)).toEqual({ confirmation: null, dispatch: null });
    expect(confirmDockerAction(pending, true)).toEqual({
      confirmation: null,
      dispatch: { id: target.id, action: "kill" },
    });
  });
});
