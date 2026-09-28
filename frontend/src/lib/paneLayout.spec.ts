import { describe, expect, it } from "vitest";
import { DOCKER_PANE_MIN_WIDTH, clampDockerPaneWidth, terminalFlexBasis } from "./paneLayout";

describe("terminalFlexBasis", () => {
  it("gives the terminal the full row when nothing else is open", () => {
    expect(terminalFlexBasis({ sftpOpen: false, dockerOpen: false, splitRatio: 58 })).toBe("100%");
  });

  it("keeps the user split ratio when only SFTP is open", () => {
    expect(terminalFlexBasis({ sftpOpen: true, dockerOpen: false, splitRatio: 62 })).toBe("62%");
  });

  it("yields the docked docker pane width when only the docker panel is open", () => {
    expect(terminalFlexBasis({ sftpOpen: false, dockerOpen: true, splitRatio: 58 })).toBe(
      "calc(100% - var(--docker-pane-width))",
    );
  });

  it("splits the leftover space by ratio when SFTP and docker are open together", () => {
    expect(terminalFlexBasis({ sftpOpen: true, dockerOpen: true, splitRatio: 58 })).toBe(
      "calc((100% - var(--docker-pane-width)) * 0.58)",
    );
  });

  it("clamps the ratio into [0, 1] before emitting the calc", () => {
    expect(terminalFlexBasis({ sftpOpen: true, dockerOpen: true, splitRatio: 120 })).toBe(
      "calc((100% - var(--docker-pane-width)) * 1)",
    );
    expect(terminalFlexBasis({ sftpOpen: true, dockerOpen: true, splitRatio: -5 })).toBe(
      "calc((100% - var(--docker-pane-width)) * 0)",
    );
  });
});

describe("clampDockerPaneWidth", () => {
  it("floors at the minimum dock width", () => {
    expect(clampDockerPaneWidth(120, 1600)).toBe(DOCKER_PANE_MIN_WIDTH);
  });

  it("caps at 70% of the container width", () => {
    expect(clampDockerPaneWidth(2000, 1000)).toBe(700);
  });

  it("keeps the floor when the container itself is narrower than it", () => {
    expect(clampDockerPaneWidth(400, 300)).toBe(DOCKER_PANE_MIN_WIDTH);
  });

  it("keeps in-range values and rounds to whole pixels", () => {
    expect(clampDockerPaneWidth(456.4, 1600)).toBe(456);
  });
});
