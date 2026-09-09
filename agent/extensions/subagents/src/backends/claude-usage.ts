/**
 * Context occupancy after one Claude request. Result-level usage is an
 * aggregate across the run and therefore cannot represent current occupancy.
 */
export function contextOccupancyTokens(
  usage:
    | {
        input_tokens?: number | null;
        cache_read_input_tokens?: number | null;
        cache_creation_input_tokens?: number | null;
        output_tokens?: number | null;
      }
    | null
    | undefined,
) {
  if (!usage || typeof usage.input_tokens !== "number") return undefined;
  const count = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return (
    count(usage.input_tokens) +
    count(usage.cache_read_input_tokens) +
    count(usage.cache_creation_input_tokens) +
    count(usage.output_tokens)
  );
}
