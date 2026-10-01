export function graduationLabel(title: string): string | undefined {
  if (/^\d{4}$/.test(title)) return `高中毕业：${title}`;
  if (title === 'by') return '毕业';
  if (title === 'uk') return '年份未知';
  if (title === 'jl') return '教练';
  return undefined;
}
