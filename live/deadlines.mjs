export const deadlineOf=call=>call.testDeadline??(call.createdAt+900000);
export function forecast(call, minutes, now) {
  const deadline = deadlineOf(call);
  const eta = now + Math.round(minutes * 60000);
  return {eta, deadline, marginMs: deadline - eta, inTime: eta <= deadline};
}

export function comparePair(a, b) {
  function score(candidate) {
    const other = candidate.impact.remaining;
    const trips = [candidate.forecast, other].filter(Boolean);
    return [
      trips.filter(trip => !trip.inTime).length + (other ? 0 : 1),
      other ? 0 : 1,
      trips.reduce((total, trip) => total + Math.max(0, -trip.marginMs), 0),
      trips.reduce((total, trip) => total + trip.eta, 0)
    ];
  }
  const left = score(a), right = score(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return a.route.minutes - b.route.minutes;
}
