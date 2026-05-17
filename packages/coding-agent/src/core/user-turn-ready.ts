export interface UserTurnReadyCheckInput {
	isStreaming: boolean;
	hasQueuedMessages: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	hasActiveTurnWork?: boolean;
}

export function shouldEmitEpiUserTurnReady(input: UserTurnReadyCheckInput): boolean {
	return (
		!input.isStreaming &&
		!input.hasQueuedMessages &&
		!input.isCompacting &&
		!input.isRetrying &&
		!input.hasActiveTurnWork
	);
}
