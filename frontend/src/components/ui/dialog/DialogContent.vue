<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { DialogContent, DialogDescription, DialogPortal, VisuallyHidden, useForwardPropsEmits } from "reka-ui";
import { cn } from "../../../lib/utils";
import DialogOverlay from "./DialogOverlay.vue";

defineOptions({
  inheritAttrs: false,
});

// 插件所有弹窗自带 header 关闭钮，不提供宿主样式的外置 X（showCloseButton 分支已移除）。
const props = defineProps<
  DialogContentProps & {
    class?: HTMLAttributes["class"];
    overlayClass?: HTMLAttributes["class"];
    portalClass?: HTMLAttributes["class"];
  }
>();
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "overlayClass", "portalClass");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay :class="props.overlayClass" />
    <div data-slot="dialog-positioner" :class="cn('fixed inset-0 z-[80] grid place-items-center p-4 pointer-events-none grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]', props.portalClass)">
      <DialogContent
        data-slot="dialog-content"
        v-bind="{ ...$attrs, ...forwarded }"
        :class="
          cn(
            // 尺寸/留白/布局由插件 .modal 系 hook 类（unlayered）负责；这里去掉宿主
            // 的 max-w-sm/p-4/gap-4/grid/text-sm，避免压过或叠加弹层既有视觉。
            'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 relative max-h-[calc(100vh-2rem)] rounded-lg border border-border shadow-lg duration-100 outline-none pointer-events-auto',
            props.class,
          )
        "
      >
        <VisuallyHidden as-child>
          <DialogDescription />
        </VisuallyHidden>

        <slot />
      </DialogContent>
    </div>
  </DialogPortal>
</template>
