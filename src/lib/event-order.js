// Session-time fallbacks need file positions to restore chronological dialogue.
export function compareEventOrder(left, right) {
  const timeDelta = (Date.parse(left?.time || "") || 0) - (Date.parse(right?.time || "") || 0);
  if (timeDelta || !left?.sourceFile || left.sourceFile !== right?.sourceFile) return timeDelta;
  const key = Number(left.sourceLine) > 0 && Number(right.sourceLine) > 0 ? "sourceLine" : "sourceOffset";
  return (Number(left[key]) || 0) - (Number(right[key]) || 0)
    || (Number(left.lineEventIndex) || 0) - (Number(right.lineEventIndex) || 0);
}
