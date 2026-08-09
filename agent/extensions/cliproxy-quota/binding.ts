export function traceSuffix(traceId: string | undefined): string | undefined {
	const match = traceId?.match(/([0-9a-f]{8})$/i);
	return match?.[1]?.toLowerCase();
}

export function findAuthForTrace(log: string, traceId: string | undefined): string | undefined {
	const suffix = traceSuffix(traceId);
	if (!suffix) return undefined;
	const lines = log.split("\n").reverse();
	for (const line of lines) {
		if (!line.toLowerCase().includes(`[${suffix}]`) || !line.includes("session-affinity:")) continue;
		const auth = line.match(/\bauth=([^\s]+)/)?.[1];
		if (auth) return auth;
	}
	return undefined;
}
