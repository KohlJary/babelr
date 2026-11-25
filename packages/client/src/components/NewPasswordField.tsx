// SPDX-License-Identifier: MIT
import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PASSWORD_MIN_LENGTH, suggestPassphrase } from '../utils/passphrase';

interface NewPasswordFieldProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Class for the input itself (the auth form styles inputs by context). */
  inputClassName?: string;
  required?: boolean;
}

/**
 * A password field for choosing a new password: the rule said up front, a
 * show/hide button, "Suggest one" (three common words), and a quiet count to
 * the minimum. Used on sign-up and in Settings › Account.
 */
export function NewPasswordField({
  value,
  onChange,
  placeholder,
  inputClassName,
  required,
}: NewPasswordFieldProps) {
  const t = useT();
  const id = useId();
  const [visible, setVisible] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);

  const suggest = () => {
    const phrase = suggestPassphrase();
    setSuggested(phrase);
    // Shown in plain text so it can be written down.
    setVisible(true);
    onChange(phrase);
  };

  const long = value.length >= PASSWORD_MIN_LENGTH;
  const showNote = suggested !== null && value === suggested;

  return (
    <div className="new-password">
      <div className="new-password-row">
        <input
          id={`${id}-input`}
          type={visible ? 'text' : 'password'}
          className={inputClassName}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={required}
          minLength={PASSWORD_MIN_LENGTH}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={`${id}-hint${showNote ? ` ${id}-note` : ''}`}
        />
        <button
          type="button"
          className="new-password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? t('auth.passwordHideLabel') : t('auth.passwordShowLabel')}
          aria-pressed={visible}
          aria-controls={`${id}-input`}
        >
          {visible ? t('auth.passwordHide') : t('auth.passwordShow')}
        </button>
      </div>
      <div className="new-password-meta">
        <span id={`${id}-hint`} className="field-hint">
          {t('auth.passwordRule')}
        </span>
        {value.length > 0 && (
          <span className={`new-password-count${long ? ' done' : ''}`}>
            {long ? (
              <span aria-label={t('auth.passwordLongEnough')} role="img">
                ✓
              </span>
            ) : (
              t('auth.passwordCount', { count: value.length, min: PASSWORD_MIN_LENGTH })
            )}
          </span>
        )}
      </div>
      <button type="button" className="new-password-suggest" onClick={suggest}>
        {suggested ? t('auth.passwordSuggestAnother') : t('auth.passwordSuggest')}
      </button>
      {showNote && (
        <p id={`${id}-note`} className="new-password-note" role="status">
          {t('auth.passwordWriteDown')}
        </p>
      )}
    </div>
  );
}
