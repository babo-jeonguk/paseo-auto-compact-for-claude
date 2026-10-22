import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, View } from "react-native";

// Same geometry and timing as Paseo's own settings switch, so the row reads as native to the app.
const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const THUMB_SIZE = 16;
const INSET = (TRACK_HEIGHT - THUMB_SIZE) / 2;
const TRAVEL = TRACK_WIDTH - THUMB_SIZE - INSET * 2;
const DURATION_MS = 180;

/** True for a dark `#rrggbb` surface; other color formats count as light. */
function isDark(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! < 0.5;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced, () => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

export function Toggle(props: {
  value: boolean;
  onValueChange(value: boolean): void;
  disabled?: boolean;
  accessibilityLabel: string;
  theme: PluginScreenProps["theme"];
}) {
  const { value, disabled, theme } = props;
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      duration: reducedMotion ? 0 : DURATION_MS,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [progress, reducedMotion, value]);

  const translateX = progress.interpolate({ inputRange: [0, 1], outputRange: [0, TRAVEL] });
  // Paseo's thumb is light when off in both themes and takes the accent's text color when on.
  const offThumb = isDark(theme.colors.surface0) ? theme.colors.foreground : theme.colors.surface0;
  return (
    <Pressable
      onPress={() => {
        if (!disabled) props.onValueChange(!value);
      }}
      disabled={disabled}
      hitSlop={12}
      accessibilityRole="switch"
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      accessibilityLabel={props.accessibilityLabel}
      style={{ opacity: disabled ? 0.5 : 1, minHeight: 28, justifyContent: "center" }}
    >
      <View style={{ width: TRACK_WIDTH, height: TRACK_HEIGHT, borderRadius: TRACK_HEIGHT / 2, overflow: "hidden" }}>
        {/* Theme tokens have no switch-track color; a translucent muted fill clears both themes. */}
        <View
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.foregroundMuted, opacity: 0.35 }}
        />
        <Animated.View
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: theme.colors.accent, opacity: progress }}
        />
        <Animated.View
          style={{
            position: "absolute",
            top: INSET,
            left: INSET,
            width: THUMB_SIZE,
            height: THUMB_SIZE,
            borderRadius: THUMB_SIZE / 2,
            backgroundColor: value ? theme.colors.accentForeground : offThumb,
            shadowColor: "rgba(0, 0, 0, 0.25)",
            shadowOffset: { width: 0, height: 1 },
            shadowRadius: 2,
            shadowOpacity: 1,
            elevation: 2,
            transform: [{ translateX }],
          }}
        />
      </View>
    </Pressable>
  );
}
