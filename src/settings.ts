export type GlobalSettings = {
    updateProcessInterval: number;
}

/**
 * Settings for {@link IncrementCounter}.
 */
export type SoundSwitchSettings = {
	count?: number;
	incrementBy?: number;
	curSelectedDeviceId?: string;
	activeDevices?: string[];
	showInactive: boolean;
};

export type TestActionSettings = {
	count?: number;
	incrementBy?: number;
}