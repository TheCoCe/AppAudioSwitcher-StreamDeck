import streamDeck, { Action, action, DialRotateEvent, DidReceiveSettingsEvent, KeyDownEvent, KeyUpEvent, SingletonAction, WillAppearEvent, WillDisappearEvent, type SendToPluginEvent } from "@elgato/streamdeck";
import { JsonValue } from "@elgato/utils";
import type { DataSourcePayload, DataSourceResult } from "../sdpi";
import type { DialAction, DialDownEvent, KeyAction } from "@elgato/streamdeck";
import { ChildProcess, exec, ExecException, spawn } from "child_process";
import { GlobalSettings, SoundSwitchSettings } from "../settings";
import { Socket } from "net";
import path from "path";
import { fileURLToPath } from "url";
import * as UtilTypes from "../audioSwitcherUtilTypes";
import { AudioSwitcherUtilClient } from "../audioSwitcherUtilClient";

/**
 * An example action class that displays a count that increments by one each time the button is pressed.
 */
@action({ UUID: "com.serafin-kaiser.appaudioswitcher.switchappaudio" })
export class SwitchAppAudioAction extends SingletonAction<SoundSwitchSettings> {
	private curDevices: Array<UtilTypes.DeviceInfo> = new Array();
	private timer: NodeJS.Timeout | undefined;
	private processInfo: UtilTypes.FocusedMessageResponse | undefined;
	private forceProcessUpdate: boolean = false;
	private client: AudioSwitcherUtilClient = new AudioSwitcherUtilClient(32122);

	// --- Utils Server ---

	private utilsServerProcess: ChildProcess | null = null;

	async tryLaunchUtilsServer(restart: boolean = false): Promise<void> {
		if (restart) {
			this.endUtilsServer();
		}

		if (this.utilsServerProcess !== null) {
			return;
		}

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.utilsServerProcess?.kill();
				this.utilsServerProcess = null;
				reject(new Error("Server startup timed out"))
			}, 5000);

			try {
				const executablePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "audioSwitcherUtil", "AppAudioSwitcherUtility.exe");
				streamDeck.logger.info("Launching utils server...");
				this.utilsServerProcess = spawn(executablePath, ["--server"]);
				this.utilsServerProcess.on("spawn", () => {
					clearTimeout(timeout);
					resolve();
				});
				this.utilsServerProcess.on("error", (err) => {
					clearTimeout(timeout);
					streamDeck.logger.error("Encountered error while launching utils server: ", err);
					reject(err);
				})
			}
			catch (e) {
				clearTimeout(timeout);
				streamDeck.logger.error("timeout? or exception")
				reject(e);
			}
		})
	}

	endUtilsServer() {
		this.client?.disconnect();

		if (this.utilsServerProcess !== null) {
			this.utilsServerProcess.kill();
		}
	}

	isConnected() {
		if (this.utilsServerProcess == null) {
			return false;
		}
		if (this.client == null || !this.client.isConnected()) {
			return false;
		}
		return true;
	}

	async tryConnectToUtilsServer(skipLaunch: boolean = false): Promise<void> {
		if (this.isConnected()) {
			return;
		}

		if (!skipLaunch) {
			await this.tryLaunchUtilsServer();
		}

		await this.client.connect(5, 500);
	}

	async handleDevicesMessageReceived(devicesPayload: UtilTypes.DevicesMessageResponse) {
		this.curDevices = devicesPayload.Devices ?? [];
		// After receiving devices, immediately update process
		this.client.send(UtilTypes.FocusedMessageRequest, { Icon: true });
	}

	async handleFocusedMessageReceived(focusedPayload: UtilTypes.FocusedMessageResponse) {
		if (focusedPayload === undefined) return;

		const shouldUpdate = focusedPayload.ProcessId !== this.processInfo?.ProcessId
			|| focusedPayload.HasSession !== this.processInfo.HasSession
			|| focusedPayload.DeviceId !== this.processInfo.DeviceId
			|| (focusedPayload.ProcessIconBase64 && focusedPayload.ProcessIconBase64 != this.processInfo?.ProcessIconBase64)
			&& focusedPayload.ProcessId !== 0 || this.forceProcessUpdate;

		if (shouldUpdate) {
			this.forceProcessUpdate = false;
			this.processInfo = {
				ProcessId: focusedPayload.ProcessId,
				ProcessName: focusedPayload.ProcessName,
				DeviceId: focusedPayload.DeviceId,
				HasSession: focusedPayload.HasSession,
				// icon is only sent when the process changes, updates do not include it, so make sure to preserve the icon when updates for the process come in
				ProcessIconBase64: this.processInfo?.ProcessId == focusedPayload.ProcessId && !focusedPayload.ProcessIconBase64 ? this.processInfo.ProcessIconBase64 : focusedPayload.ProcessIconBase64
			};

			for (const action of this.actions) {
				action.setTitle(this.processInfo.ProcessName);
				if (action.isDial()) {
					if (this.processInfo.DeviceId !== '') {
						await this.trySetCurSelectedDeviceId(action, this.processInfo.DeviceId);
					}

					this.updateDialLayout(action).then();

					if (focusedPayload.ProcessIconBase64 !== undefined) {
						action.setFeedback({
							icon: `data:image/png;base64,${focusedPayload.ProcessIconBase64}`
						}).then()
					}
				}
			}
		}
	}

	private async updateDialLayout(action: DialAction<SoundSwitchSettings>) {
		// Update 
		const deviceInfo = await this.getCurDeviceForAction(action);

		if (this.processInfo?.HasSession || this.processInfo?.DeviceId !== "") {
			await action.setFeedback({
				value: deviceInfo?.DeviceName.toString() ?? "None",
			});
		}
		else {
			await action.setFeedback({
				value: "-",
			})
		}
	}

	private async getActionDeviceData(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, filter: UtilTypes.DeviceState = UtilTypes.DeviceState.MASK_ALL): Promise<UtilTypes.ActionDeviceInfo | null> {
		if (action === undefined) return null;
		const settings = await action?.getSettings();
		if (settings === undefined) return null;
		const devicesForAction = this.curDevices.filter((d) => settings.activeDevices?.includes(d.DeviceId) && d.State & filter);
		let deviceIndex = devicesForAction.findIndex((d) => (d.DeviceId === settings.curSelectedDeviceId));
		return { settings: settings, devices: devicesForAction, curDeviceIdx: deviceIndex };
	}

	private async getCurDeviceForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>): Promise<UtilTypes.DeviceInfo | undefined> {
		const actionDeviceInfo = await this.getActionDeviceData(action);
		if (actionDeviceInfo === null) return undefined;

		let idx = actionDeviceInfo?.curDeviceIdx ?? 0;
		if (actionDeviceInfo.devices.length == 0) return undefined;
		if (idx < 0 || idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}

		const deviceInfo = this.curDevices.find((d) => d.DeviceId === actionDeviceInfo.devices[idx]?.DeviceId);
		return deviceInfo;
	}

	private async trySetCurSelectedDeviceId(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, deviceId: string) {
		let activationDeviceInfo = await this.getActionDeviceData(action);
		if (activationDeviceInfo === null) return;

		const device = activationDeviceInfo.devices.find((d) => d.DeviceId === deviceId);
		if (device !== undefined) {
			activationDeviceInfo.settings.curSelectedDeviceId = deviceId;
			await action.setSettings(activationDeviceInfo.settings);
		}
	}

	private async cycleDeviceIndexForAction(action: DialAction<SoundSwitchSettings> | KeyAction<SoundSwitchSettings>, incr: boolean) {
		let actionDeviceInfo = await this.getActionDeviceData(action, UtilTypes.DeviceState.ACTIVE);
		if (actionDeviceInfo === null) return;
		if (actionDeviceInfo.devices.length == 0) {
			streamDeck.logger.info("No devices to switch to!");
			return;
		}

		let idx = actionDeviceInfo.curDeviceIdx;
		idx = idx + (incr ? 1 : -1);
		if (idx < 0) {
			idx = actionDeviceInfo.devices.length - 1;
		}
		else if (idx >= actionDeviceInfo.devices.length) {
			idx = 0;
		}

		actionDeviceInfo.settings.curSelectedDeviceId = actionDeviceInfo.devices[idx].DeviceId;
		await action.setSettings(actionDeviceInfo.settings);
	}

	/**
	 * The {@link SingletonAction.onWillAppear} event is useful for setting the visual representation of an action when it becomes visible. This could be due to the Stream Deck first
	 * starting up, or the user navigating between pages / folders etc.. There is also an inverse of this event in the form of {@link streamDeck.client.onWillDisappear}. In this example,
	 * we're setting the title to the "count" that is incremented in {@link SwitchAppAudioAction.onKeyDown}.
	 */
	override async onWillAppear(ev: WillAppearEvent<SoundSwitchSettings>): Promise<void> {
		streamDeck.logger.info("onWillAppear");
		try {
			await this.tryConnectToUtilsServer();

			this.client.on(UtilTypes.DevicesMessageResponse, (payload) => {
				this.handleDevicesMessageReceived(payload);
			});

			this.client.on(UtilTypes.FocusedMessageResponse, (payload) => {
				this.handleFocusedMessageReceived(payload);
			});
		}
		catch (e) {
			streamDeck.logger.error("Failed to launch utils server:", e);
			return;
		}

		this.client.send(UtilTypes.DevicesMessageRequest, { DataFlow: UtilTypes.DataFlow.eRender });
		// Make sure the next process update will be applied, otherwise icon won't be set properly
		this.forceProcessUpdate = true;
		this.client.send(UtilTypes.FocusedMessageRequest, { Icon: true });
	}

	override onWillDisappear(ev: WillDisappearEvent<SoundSwitchSettings>): Promise<void> | void {
		if (this.actions.next().done) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Listens for the {@link SingletonAction.onKeyDown} event which is emitted by Stream Deck when an action is pressed. Stream Deck provides various events for tracking interaction
	 * with devices including key down/up, dial rotations, and device connectivity, etc. When triggered, {@link ev} object contains information about the event including any payloads
	 * and action information where applicable. In this example, our action will display a counter that increments by one each press. We track the current count on the action's persisted
	 * settings using `setSettings` and `getSettings`.
	 */
	override async onKeyDown(ev: KeyDownEvent<SoundSwitchSettings>): Promise<void> {
		// Update the count from the settings.
		const { settings } = ev.payload;
		settings.incrementBy ??= 1;
		settings.count = (settings.count ?? 0) + settings.incrementBy;

		// Update the current count in the action's settings, and change the title.
		await ev.action.setSettings(settings);
		await ev.action.setTitle(`${settings.count}`);
	}

	override async onDialRotate(ev: DialRotateEvent<SoundSwitchSettings>): Promise<void> {
		const ticks = ev.payload.ticks;
		await this.cycleDeviceIndexForAction(ev.action, ticks > 0);
		this.updateDialLayout(ev.action);
	}

	override async onDialDown(ev: DialDownEvent<SoundSwitchSettings>): Promise<void> {
		const device = await this.getCurDeviceForAction(ev.action);
		if (device) {
			if (this.processInfo) {
				this.client.send(UtilTypes.SetAppDeviceMessageRequest, { ProcessId: this.processInfo.ProcessId, DeviceId: device.DeviceId });
			}
		}
	}

	/** This is needed because action.getSettings will cause a call to onDidReceiveSettings	which will cause a loop if not suppressed. */
	private supressSettingChanged: boolean = false;

	override onDidReceiveSettings(ev: DidReceiveSettingsEvent<SoundSwitchSettings>): Promise<void> | void {
		if (this.supressSettingChanged) return;
		const settings = ev.payload.settings;
		streamDeck.ui.sendToPropertyInspector({
			event: "getProducts",
			items: this.#getAvailableDevices(settings.showInactive),
		} satisfies DataSourcePayload);
	}

	/**
	 * Listen for messages from the property inspector.
	 * @param ev Event information.
	 */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, SoundSwitchSettings>): Promise<void> {
		// Check if the payload is requesting a data source, i.e. the structure is { event: string }
		if (ev.payload instanceof Object && "event" in ev.payload && ev.payload.event === "getProducts") {
			this.supressSettingChanged = true;
			const settings = await ev.action.getSettings<SoundSwitchSettings>();
			this.supressSettingChanged = false;
			// Send the product ranges to the property inspector.
			streamDeck.ui.sendToPropertyInspector({
				event: "getProducts",
				items: this.#getAvailableDevices(settings.showInactive),
			} satisfies DataSourcePayload);
		}
	}

	#getAvailableDevices(showInactive: boolean): DataSourceResult {
		const devices = showInactive ? this.curDevices : this.curDevices.filter((d) => d.State & UtilTypes.DeviceState.ACTIVE);
		let array = devices.map((device) =>
		({
			value: device.DeviceId,
			label: showInactive ? `${device.DeviceName} - ${UtilTypes.DeviceState[device.State]}` : device.DeviceName
		}))
		return array;
	}
}