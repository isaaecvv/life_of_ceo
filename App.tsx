import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import * as SplashScreen from 'expo-splash-screen';
import { File, Paths } from 'expo-file-system';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { WEB_HTML } from './src/webHtml';

SplashScreen.preventAutoHideAsync().catch(() => {});

// Пока приложение открыто, напоминания показывает сам интерфейс — системный баннер не дублируем.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

type ScheduleItem = { at: number; title: string; body: string; action?: string };
type BridgeMessage =
  | { type: 'ready' }
  | { type: 'save'; data: string }
  | { type: 'schedule'; items: ScheduleItem[] }
  | { type: 'haptic'; kind: 'light' | 'success' }
  | { type: 'speechStart' }
  | { type: 'speechStop' }
  | { type: 'backup'; data: string; name: string }
  | { type: 'restore' };

const stateFile = () => new File(Paths.document, 'state.json');

function readSavedState(): string | null {
  try {
    const f = stateFile();
    if (!f.exists) return null;
    const txt = f.textSync();
    JSON.parse(txt); // проверяем, что файл целый
    return txt;
  } catch {
    return null;
  }
}

function writeState(data: string) {
  try {
    const f = stateFile();
    if (!f.exists) f.create();
    f.write(data);
  } catch (e) {
    console.warn('Не удалось сохранить данные', e);
  }
}

// Расписание уведомлений: каждый раз пересобираем целиком (у iOS лимит 64 запланированных).
let scheduling: Promise<void> = Promise.resolve();
function reschedule(items: ScheduleItem[]) {
  scheduling = scheduling.then(async () => {
    try {
      await Notifications.cancelAllScheduledNotificationsAsync();
      const now = Date.now();
      for (const it of items.slice(0, 60)) {
        if (it.at <= now + 5000) continue;
        await Notifications.scheduleNotificationAsync({
          content: { title: it.title, body: it.body, sound: 'default', data: it.action ? { action: it.action } : {} },
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: it.at },
        });
      }
    } catch (e) {
      console.warn('Не удалось запланировать уведомления', e);
    }
  });
}

export default function App() {
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const pendingAction = useRef<string | null>(null);

  const initialState = useMemo(readSavedState, []);
  const beforeLoad = useMemo(
    () => `window.__NATIVE__=true;window.__INITIAL_STATE__=${initialState ?? 'null'};true;`,
    [initialState],
  );

  const run = useCallback((js: string) => {
    web.current?.injectJavaScript(`try{${js}}catch(e){};true;`);
  }, []);

  const runAction = useCallback(
    (action: string | undefined) => {
      if (action !== 'reflect') return;
      if (ready.current) run('window.__openReflect && window.__openReflect()');
      else pendingAction.current = action;
    },
    [run],
  );

  useEffect(() => {
    Notifications.requestPermissionsAsync().catch(() => {});
    const last = Notifications.getLastNotificationResponse();
    runAction(last?.notification.request.content.data?.action as string | undefined);
    const sub = Notifications.addNotificationResponseReceivedListener((r) =>
      runAction(r.notification.request.content.data?.action as string | undefined),
    );
    const app = AppState.addEventListener('change', (s) => {
      if (s === 'active') run('window.__onForeground && window.__onForeground()');
    });
    return () => {
      sub.remove();
      app.remove();
    };
  }, [run, runAction]);

  // Голос: распознавание речи iOS, текст отдаём интерфейсу
  useSpeechRecognitionEvent('start', () => run('window.__speech.onStart()'));
  useSpeechRecognitionEvent('result', (e) => {
    const text = e.results[0]?.transcript ?? '';
    run(`window.__speech.onResult(${JSON.stringify(text)}, ${e.isFinal ? 'true' : 'false'})`);
  });
  useSpeechRecognitionEvent('end', () => run('window.__speech.onEnd()'));
  useSpeechRecognitionEvent('error', (e) => run(`window.__speech.onError(${JSON.stringify(e.error)})`));

  const onMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ready':
          ready.current = true;
          SplashScreen.hideAsync().catch(() => {});
          if (pendingAction.current) {
            runAction(pendingAction.current);
            pendingAction.current = null;
          }
          break;
        case 'save':
          writeState(msg.data);
          break;
        case 'schedule':
          reschedule(msg.items);
          break;
        case 'haptic':
          if (msg.kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          else Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
          break;
        case 'speechStart': {
          const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
          if (!perm.granted) {
            run(`window.__speech.onError("not-allowed")`);
            break;
          }
          ExpoSpeechRecognitionModule.start({ lang: 'ru-RU', interimResults: true, continuous: false });
          break;
        }
        case 'speechStop':
          ExpoSpeechRecognitionModule.stop();
          break;
        case 'backup': {
          try {
            const f = new File(Paths.cache, msg.name);
            if (f.exists) f.delete();
            f.create();
            f.write(msg.data);
            await Sharing.shareAsync(f.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Резервная копия Life of CEO' });
          } catch {
            run(`window.__notify("Не получилось сохранить копию.")`);
          }
          break;
        }
        case 'restore': {
          try {
            const res = await DocumentPicker.getDocumentAsync({ type: ['application/json', 'public.json', '*/*'], copyToCacheDirectory: true });
            if (res.canceled || !res.assets?.length) break;
            const txt = await new File(res.assets[0].uri).text();
            run(`window.__restore(${JSON.stringify(txt)})`);
          } catch {
            run(`window.__restore("")`);
          }
          break;
        }
      }
    },
    [run, runAction],
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <WebView
        ref={web}
        style={styles.web}
        source={{ html: WEB_HTML, baseUrl: 'https://app.lifeofceo.local/' }}
        originWhitelist={['*']}
        injectedJavaScriptBeforeContentLoaded={beforeLoad}
        onMessage={onMessage}
        javaScriptEnabled
        domStorageEnabled
        scrollEnabled={false}
        bounces={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        allowsBackForwardNavigationGestures={false}
        allowsLinkPreview={false}
        textInteractionEnabled
        setSupportMultipleWindows={false}
        onContentProcessDidTerminate={() => web.current?.reload()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
