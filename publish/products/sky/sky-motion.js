export function wrapPosition(value, size, margin = 64) {
  const span = size + margin * 2;
  return ((((value + margin) % span) + span) % span) - margin;
}

export function skyPosition(x, y, seconds, depth, width, height, margin = 64) {
  const distance = seconds * (1.5 + depth * 3);
  return [
    wrapPosition(x - distance, width, margin),
    wrapPosition(y + distance * 0.28, height, margin),
  ];
}
