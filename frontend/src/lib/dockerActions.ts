export type DockerActionName = "start" | "stop" | "restart" | "kill" | "rm";

export interface DockerActionTarget {
  id: string;
  name: string;
}

export interface DockerActionDispatch {
  id: string;
  action: DockerActionName;
}

export interface DockerActionTransition {
  confirmation: (DockerActionTarget & { action: DockerActionName }) | null;
  dispatch: DockerActionDispatch | null;
}

/** Kill and remove are destructive, so only an explicit confirmation may dispatch them. */
export function requestDockerAction(target: DockerActionTarget, action: DockerActionName): DockerActionTransition {
  if (action === "kill" || action === "rm") {
    return { confirmation: { ...target, action }, dispatch: null };
  }
  return { confirmation: null, dispatch: { id: target.id, action } };
}

export function confirmDockerAction(
  pending: (DockerActionTarget & { action: DockerActionName }) | null,
  accepted: boolean,
): DockerActionTransition {
  if (!pending || !accepted) return { confirmation: null, dispatch: null };
  return { confirmation: null, dispatch: { id: pending.id, action: pending.action } };
}
