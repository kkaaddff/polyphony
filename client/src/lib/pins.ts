// 文档置顶(移动端列表):本机偏好,存 localStorage,不上服务端——
// 服务端房间簿刻意保持稳定顺序(联调反馈),置顶只是本机视图层的排序。
import { useCallback } from "react";
import { useLocalStorageState } from "./storage";

export const PINNED_KEY = "polyphony.pinned";
const EMPTY: string[] = [];

export function usePinned() {
  const [pinned, setPinned] = useLocalStorageState<string[]>(PINNED_KEY, EMPTY);

  /** 批量置顶/取消:on=true 置顶(新置顶的排最前),false 取消。 */
  const setPins = useCallback(
    (codes: string[], on: boolean) =>
      setPinned((prev) => {
        const rest = prev.filter((c) => !codes.includes(c));
        return on ? [...codes, ...rest] : rest;
      }),
    [setPinned]
  );

  return { pinned, setPins };
}
