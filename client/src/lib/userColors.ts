// 声部色:userId 哈希 → 8 色(协同光标与头像共用,颜色随身份稳定)。
// 饱和度相近、彼此可分;白字 initials 在每一色上都 ≥ 3.6:1。
// 注意:改这张表会让存量用户「换色」——光标、头像一起变,属于可见的身份变更,慎改。

export const USER_COLORS = [
  "#4F46E5", // indigo
  "#0284C7", // sky
  "#7C3AED", // violet
  "#D23C69", // rose
  "#0D8A72", // teal
  "#B7791F", // amber
  "#D9563C", // coral
  "#9C4BB5", // plum
];

export function getUserColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}
