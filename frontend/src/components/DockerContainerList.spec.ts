// @vitest-environment happy-dom
// 列表的搜索/状态筛选是本地纯逻辑，组件测试只验证「输入 → 行集变化」这条线；
// 行操作菜单的派发由 lib/dockerRowMenu + lib/dockerContainerFilter 的分工覆盖。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import DockerContainerList from "./DockerContainerList.vue";

const t = (key: string) => key;

function container(overrides: Record<string, string> = {}) {
  return {
    id: "3f2a1b4c5d6e",
    name: "web-1",
    image: "nginx:1.27",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:8080->80/tcp",
    createdAt: "2026-11-20",
    ...overrides,
  };
}

const containers = [
  container(),
  container({ id: "9c8b7a6f5e4d", name: "db-1", image: "postgres:16", state: "exited", status: "Exited (0) 1h ago", ports: "" }),
  container({ id: "112233aabbcc", name: "cache", image: "redis:7", state: "paused", status: "Paused", ports: "6379/tcp" }),
];

function mountList() {
  return mount(DockerContainerList, { props: { t, containers, busyIds: [] } });
}

function rowNames(wrapper: ReturnType<typeof mountList>): string[] {
  return wrapper.findAll(".docker-cell-name strong").map((node) => node.text());
}

describe("DockerContainerList", () => {
  it("shows every container and the terminal hint by default", () => {
    const wrapper = mountList();
    expect(rowNames(wrapper)).toEqual(["web-1", "db-1", "cache"]);
    expect(wrapper.text()).toContain("docker.terminalHint");
    expect(wrapper.find('[data-test="docker-no-match"]').exists()).toBe(false);
  });

  it("narrows the rows while typing and shows the match count", async () => {
    const wrapper = mountList();
    await wrapper.find('[data-test="docker-search"]').setValue("postgres");
    expect(rowNames(wrapper)).toEqual(["db-1"]);
    expect(wrapper.find('[data-test="docker-match-count"]').text()).toBe("1/3");
    await wrapper.find('[data-test="docker-search"]').setValue("");
    expect(rowNames(wrapper)).toHaveLength(3);
  });

  it("applies the state filter on top of the query", async () => {
    const wrapper = mountList();
    await wrapper.find('[data-test="docker-filter"]').setValue("stopped");
    expect(rowNames(wrapper)).toEqual(["db-1", "cache"]);
    await wrapper.find('[data-test="docker-search"]').setValue("redis");
    expect(rowNames(wrapper)).toEqual(["cache"]);
    await wrapper.find('[data-test="docker-filter"]').setValue("running");
    expect(wrapper.find('[data-test="docker-no-match"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="docker-no-match"]').text()).toBe("docker.noMatch");
  });

  it("clears the query from the clear button", async () => {
    const wrapper = mountList();
    const input = wrapper.find('[data-test="docker-search"]');
    await input.setValue("web");
    expect(rowNames(wrapper)).toEqual(["web-1"]);
    await wrapper.find(".docker-search-clear").trigger("click");
    expect((input.element as HTMLInputElement).value).toBe("");
    expect(rowNames(wrapper)).toHaveLength(3);
  });
});
