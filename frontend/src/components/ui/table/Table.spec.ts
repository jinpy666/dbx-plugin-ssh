// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from ".";

describe("Table", () => {
  it("renders semantic table parts and forwards classes", () => {
    const wrapper = mount({
      components: { Table, TableBody, TableCell, TableHead, TableHeader, TableRow },
      template: `<Table class="process-table"><TableHeader><TableRow><TableHead class="numeric">CPU</TableHead></TableRow></TableHeader><TableBody><TableRow class="process-row"><TableCell class="mono">12%</TableCell></TableRow></TableBody></Table>`,
    });
    expect(wrapper.find("table.process-table").exists()).toBe(true);
    expect(wrapper.find("thead tr th.numeric").text()).toBe("CPU");
    expect(wrapper.find("tbody tr.process-row td.mono").text()).toBe("12%");
    expect(wrapper.find('[data-slot="table-row"]').attributes("class")).toContain("border-b");
  });
});
