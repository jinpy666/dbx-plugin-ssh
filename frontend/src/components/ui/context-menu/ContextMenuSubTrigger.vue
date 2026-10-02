<script setup lang="ts">
import type { ContextMenuSubTriggerProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ContextMenuSubTrigger, useForwardProps } from "reka-ui";
import { cn } from "../../../lib/utils";

const props = defineProps<
  ContextMenuSubTriggerProps & {
    class?: HTMLAttributes["class"];
    inset?: boolean;
  }
>();

const delegatedProps = reactiveOmit(props, "class");
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
  <ContextMenuSubTrigger
    data-slot="context-menu-sub-trigger"
    :data-inset="inset ? '' : undefined"
    v-bind="forwardedProps"
    :class="
      cn(
        'focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground gap-2 rounded-md px-2 py-1 text-[13px] data-inset:pl-7 [&_svg:not([class*=size-])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50',
        props.class,
      )
    "
  >
    <slot />
  </ContextMenuSubTrigger>
</template>
