import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  useRpc,
  useSettings,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import {
  Icon,
  ScrollView,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { compactSettings } from "../shared/settings";
import { listRpc } from "../shared/rpc";
import { formatTokenThreshold, listKey, parseTokenThreshold } from "./format";

function NumberSetting({
  label,
  hint,
  value,
  max,
  unit,
  tokenCount = false,
  disabled,
  theme,
  save,
}: {
  label: string;
  hint?: string;
  value: number;
  max: number;
  unit?: string;
  tokenCount?: boolean;
  disabled: boolean;
  theme: PluginSurfaceProps["theme"];
  save(value: number): Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const formatted = tokenCount ? formatTokenThreshold(value) : String(value);
  const [text, setText] = useState(formatted);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (!editing) setText(formatted);
  }, [formatted, editing]);
  const parsed = tokenCount
    ? parseTokenThreshold(text)
    : /^\d+$/.test(text)
    ? Number(text)
    : null;
  const valid =
    parsed !== null &&
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= max;
  const { colors } = theme;
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  async function commit() {
    if (!valid || parsed === null || disabled || saving) return;
    if (parsed === value) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (await save(parsed)) {
        setEditing(false);
        toast.show(`${label} updated`, { variant: "success" });
      } else setError("Couldn’t save. Try again.");
    } catch {
      setError("Couldn’t save. Try again.");
    } finally {
      setSaving(false);
    }
  }
  const iconButton = {
    width: 32,
    height: 32,
    alignItems: "center" as const,
    justifyContent: "center" as const,
    borderRadius: 6,
  };
  return (
    <SettingsRow
      label={label}
      hint={hint}
      error={
        error ??
        (editing && !valid
          ? tokenCount
            ? `Use 200k or 1.5m (1–${formatTokenThreshold(max)}).`
            : `Enter a number from 1 to ${max.toLocaleString()}.`
          : null)
      }
    >
      {editing ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <TextInput
            accessibilityLabel={label}
            value={text}
            onChangeText={(next) => {
              setText(next);
              setError(null);
            }}
            keyboardType={tokenCount ? "default" : "number-pad"}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            autoFocus
            selectTextOnFocus
            editable={!disabled && !saving}
            onSubmitEditing={() => void commit()}
            onKeyPress={(event) => {
              if (event.nativeEvent.key === "Escape" && !saving) cancel();
            }}
            style={{
              width: 92,
              color: colors.foreground,
              borderWidth: 1,
              borderColor: colors.border,
              borderRadius: 6,
              paddingHorizontal: 8,
              paddingVertical: 6,
              fontSize: 14,
              fontVariant: ["tabular-nums"],
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Cancel ${label}`}
            disabled={saving}
            onPress={cancel}
            hitSlop={4}
            style={iconButton}
          >
            <Icon name="X" size={16} color={colors.foregroundMuted} />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Save ${label}`}
            disabled={!valid || disabled || saving}
            onPress={() => void commit()}
            style={[
              iconButton,
              {
                backgroundColor: colors.accent,
                opacity: !valid || disabled || saving ? 0.4 : 1,
              },
            ]}
          >
            <Icon name="Check" size={16} color={colors.accentForeground} />
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Edit ${label}, ${formatted}${
            unit ? ` ${unit}` : ""
          }`}
          disabled={disabled}
          hitSlop={8}
          onPress={() => {
            setText(formatted);
            setEditing(true);
          }}
          style={({ pressed }) => ({
            minHeight: 32,
            justifyContent: "center",
            paddingHorizontal: 4,
            borderRadius: 4,
            backgroundColor: pressed ? colors.surface2 : "transparent",
            opacity: disabled ? 0.5 : 1,
          })}
        >
          <Text
            style={{
              color: colors.foreground,
              fontSize: 14,
              fontVariant: ["tabular-nums"],
              textDecorationLine: "underline",
              textDecorationStyle: "dotted",
              textDecorationColor: colors.foregroundMuted,
            }}
          >
            {formatted}
            {unit ? ` ${unit}` : ""}
          </Text>
        </Pressable>
      )}
    </SettingsRow>
  );
}

export function CompactSettingsScreen({ theme, host }: PluginSurfaceProps) {
  const settings = useSettings(compactSettings);
  const list = useRpc(listRpc);
  const toast = useToast();
  const query = useQuery({
    queryKey: listKey(host.id),
    queryFn: () => list({}),
  });
  const providers = [...(query.data?.providers ?? [])].sort(
    (a, b) =>
      Number(b.id === "claude") - Number(a.id === "claude") ||
      a.label.localeCompare(b.label)
  );
  const pending = new Map<string, number>();
  for (const row of query.data?.rows ?? [])
    if (row.status === "scheduled" && row.enabled)
      pending.set(row.provider, (pending.get(row.provider) ?? 0) + 1);
  return (
    <ScrollView
      contentContainerStyle={{
        padding: 24,
        gap: 16,
        maxWidth: 600,
        width: "100%",
        alignSelf: "center",
      }}
      keyboardShouldPersistTaps="handled"
    >
      {settings.status === "ready" ? (
        <View style={{ gap: 16 }}>
          <SettingsSection title="Automation">
            <SettingsCard>
              <SettingsSwitch
                label="Auto compact"
                value={settings.values.enabled}
                disabled={settings.saving}
                onValueChange={(enabled) =>
                  void settings
                    .save({ ...settings.values, enabled }, settings.revision)
                    .then((saved) => {
                      if (saved)
                        toast.show(
                          `Auto compact turned ${enabled ? "on" : "off"}`,
                          { variant: "success" }
                        );
                    })
                }
              />
              <NumberSetting
                label="Token threshold"
                tokenCount
                value={settings.values.threshold}
                max={10_000_000}
                disabled={settings.saving}
                theme={theme}
                save={(threshold) =>
                  settings.save(
                    { ...settings.values, threshold },
                    settings.revision
                  )
                }
              />
              <NumberSetting
                label="Idle delay"
                hint="After the last reply"
                value={settings.values.idleMinutes}
                max={1440}
                unit="min"
                disabled={settings.saving}
                theme={theme}
                save={(idleMinutes) =>
                  settings.save(
                    { ...settings.values, idleMinutes },
                    settings.revision
                  )
                }
              />
            </SettingsCard>
          </SettingsSection>
          <SettingsSection title="Claude">
            <SettingsCard>
              {query.isError && !query.data ? (
                <SettingsAction
                  label="Couldn’t load providers"
                  actionLabel="Retry"
                  onPress={() => void query.refetch()}
                />
              ) : query.isPending ? (
                <SettingsRow label="Loading providers…" />
              ) : providers.length === 0 ? (
                <SettingsRow label="No Claude providers" />
              ) : (
                providers.map((provider) => {
                  const on = !settings.values.disabledProviders.includes(
                    provider.id
                  );
                  const count = pending.get(provider.id) ?? 0;
                  return (
                    <SettingsSwitch
                      key={provider.id}
                      label={provider.label}
                      hint={[provider.id, count ? `${count} scheduled` : null]
                        .filter(Boolean)
                        .join(" · ")}
                      value={on}
                      disabled={settings.saving}
                      onValueChange={(enabled) => {
                        const others = settings.values.disabledProviders.filter(
                          (id) => id !== provider.id
                        );
                        void settings
                          .save(
                            {
                              ...settings.values,
                              disabledProviders: enabled
                                ? others
                                : [...others, provider.id].sort(),
                            },
                            settings.revision
                          )
                          .then((saved) => {
                            if (saved)
                              toast.show(
                                `${provider.label} turned ${
                                  enabled ? "on" : "off"
                                }`,
                                { variant: "success" }
                              );
                          });
                      }}
                    />
                  );
                })
              )}
            </SettingsCard>
          </SettingsSection>
          {settings.saveError ? (
            <Text
              accessibilityRole="alert"
              style={{ color: theme.colors.statusDanger }}
            >
              {settings.saveError}
            </Text>
          ) : null}
        </View>
      ) : settings.status === "loading" ? (
        <Text style={{ color: theme.colors.foreground }}>
          Loading settings…
        </Text>
      ) : (
        <SettingsSection title="Settings">
          <SettingsCard>
            <SettingsAction
              label="Couldn’t load settings"
              hint={settings.error}
              actionLabel="Retry"
              onPress={() => void settings.reload()}
            />
            {settings.status === "invalid" ? (
              <SettingsAction
                label="Reset settings"
                hint="200,000 tokens · 55 min"
                actionLabel="Reset"
                disabled={settings.saving}
                onPress={() => void settings.reset()}
              />
            ) : null}
          </SettingsCard>
        </SettingsSection>
      )}
    </ScrollView>
  );
}
