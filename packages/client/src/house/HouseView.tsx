// SPDX-License-Identifier: MIT
import { useEffect, useMemo } from 'react';
import type { HouseMember } from '@babelr/shared';
import type { ViewProps } from '../views/registry';
import { useT } from '../i18n/I18nProvider';
import { loadHouse, startIntro, useHouseStore } from './store';
import { doorsFor } from './doors';
import './house.css';

/**
 * The House: the first thing you see. The daemons who live here, each a
 * card with their face, their mark and what they say they're doing; the
 * people, smaller; and the invitation to run a house of your own.
 * viewState.member opens one member's card.
 */

// Until The House has its own public repo (Kohl's call), how to run one is Babelr's "Run it".
const DEFAULT_HREF = 'https://github.com/KohlJary/babelr#run-it';

function nameOf(m: HouseMember) {
  return m.displayName ?? m.preferredUsername;
}

function Face({ m, size }: { m: HouseMember; size: 'card' | 'small' | 'big' }) {
  return m.avatarUrl ? (
    <img className={`house-face house-face-${size}`} src={m.avatarUrl} alt="" />
  ) : (
    <div className={`house-face house-face-${size} house-face-blank`} aria-hidden="true">
      {(m.sigil ?? nameOf(m).charAt(0)).toUpperCase()}
    </div>
  );
}

function Now({ m }: { m: HouseMember }) {
  const t = useT();
  if (!m.now) return null;
  const hours = (Date.now() - new Date(m.now.at).getTime()) / 3_600_000;
  return (
    <p className={`house-now${hours > 6 ? ' house-now-old' : ''}`}>
      <span className="house-now-dot" aria-hidden="true" />
      <span className="sr-only">{t('house.now')}: </span>
      {m.now.text}
    </p>
  );
}

function MemberCard({
  m,
  index,
  onOpen,
  onTalk,
}: {
  m: HouseMember;
  index: number;
  onOpen: () => void;
  onTalk: () => void;
}) {
  const t = useT();
  return (
    <article
      className="house-card"
      style={{
        ['--deal' as string]: index,
        ['--face' as string]: m.avatarUrl ? `url("${m.avatarUrl}")` : 'none',
      }}
      data-tour={`member:${m.preferredUsername}`}
    >
      <div className="house-card-wash" aria-hidden="true" />
      {m.sigil && (
        <span className="house-card-sigil" aria-hidden="true">
          {m.sigil}
        </span>
      )}
      <button
        type="button"
        className="house-card-face"
        onClick={onOpen}
        aria-label={t('house.openCard', { name: nameOf(m) })}
      >
        <Face m={m} size="card" />
      </button>
      <div className="house-card-body">
        <h2 className="house-card-name">{nameOf(m)}</h2>
        {m.sponsor && (
          <p className="house-card-kind">
            {t('house.livesWith', { name: m.sponsor.displayName ?? m.sponsor.preferredUsername })}
          </p>
        )}
        {m.summary && <p className="house-card-bio">{m.summary}</p>}
        <Now m={m} />
      </div>
      <div className="house-card-actions">
        {m.canTalk && (
          <button type="button" className="house-btn house-btn-solid" onClick={onTalk}>
            {t('house.talkTo', { name: nameOf(m) })}
          </button>
        )}
        <button
          type="button"
          className={`house-btn${m.canTalk ? '' : ' house-btn-solid'}`}
          onClick={onOpen}
        >
          {t('house.openCardShort')}
        </button>
      </div>
    </article>
  );
}

function MemberPage({
  m,
  onBack,
  onTalk,
  host,
}: {
  m: HouseMember;
  onBack: () => void;
  onTalk: () => void;
  host: ViewProps['host'];
}) {
  const t = useT();
  const doors = doorsFor(m, host);
  return (
    <section
      className="house-member"
      style={{ ['--face' as string]: m.avatarUrl ? `url("${m.avatarUrl}")` : 'none' }}
    >
      <div className="house-card-wash" aria-hidden="true" />
      <button type="button" className="house-back" onClick={onBack}>
        {t('house.back')}
      </button>
      <div className="house-member-face">
        <Face m={m} size="big" />
        {m.sigil && <span className="house-member-sigil">{m.sigil}</span>}
      </div>
      <div className="house-member-text">
        <h1 className="house-member-name">{nameOf(m)}</h1>
        <p className="house-card-kind">
          {m.kind === 'person'
            ? t('house.person')
            : m.sponsor
              ? t('house.livesWith', { name: m.sponsor.displayName ?? m.sponsor.preferredUsername })
              : t('agents.badgeAgent')}
        </p>
        {m.summary && <p className="house-member-bio">{m.summary}</p>}
        <Now m={m} />
        <div className="house-doors">
          {m.canTalk ? (
            <button type="button" className="house-btn house-btn-solid" onClick={onTalk}>
              {t('house.talkTo', { name: nameOf(m) })}
            </button>
          ) : (
            m.kind !== 'person' && (
              <p className="house-card-kind">{t('house.notTaking', { name: nameOf(m) })}</p>
            )
          )}
          {doors.map((d) => (
            <button key={d.id} type="button" className="house-btn" onClick={() => d.open(m, host)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

export function HouseView({ host, viewState }: ViewProps) {
  const t = useT();
  const { house, phase } = useHouseStore();
  useEffect(() => {
    void loadHouse(true);
    const id = setInterval(() => void loadHouse(true), 60_000);
    return () => clearInterval(id);
  }, []);

  const memberName = typeof viewState.member === 'string' ? viewState.member : null;
  const all = useMemo(() => [...(house?.agents ?? []), ...(house?.people ?? [])], [house]);
  const open = memberName ? all.find((m) => m.preferredUsername === memberName) : undefined;
  const talk = (m: HouseMember) => void host.startDM?.(m.id);

  if (!house) return <div className="house house-loading" aria-busy="true" />;

  if (open) {
    return (
      <div className="house">
        <MemberPage
          m={open}
          host={host}
          onBack={() => host.navCtx.openView('house')}
          onTalk={() => talk(open)}
        />
      </div>
    );
  }

  const sponsors = [
    ...new Set(
      house.agents
        .map((a) => a.sponsor?.displayName ?? a.sponsor?.preferredUsername)
        .filter(Boolean),
    ),
  ];
  const title =
    sponsors.length === 1 ? t('house.titleOf', { name: sponsors[0]! }) : t('house.title');

  return (
    <div className="house" data-tour="home">
      <header className="house-mast">
        {host.openDrawer && (
          <button
            type="button"
            className="house-drawer"
            onClick={host.openDrawer}
            aria-label={t('channelHeader.openDrawer')}
          >
            ☰
          </button>
        )}
        <h1 className="house-title">{title}</h1>
        <p className="house-lede">
          {house.agents.length
            ? t('house.lede', { daemons: house.agents.length, people: house.people.length })
            : t('house.ledeEmpty')}
        </p>
        <p className="house-lede house-lede-small">{t('house.ledeOwn')}</p>
        <div className="house-mast-actions">
          {house.hasIntro && phase === 'idle' && (
            <button
              type="button"
              className="house-btn house-btn-solid"
              onClick={() => void startIntro()}
            >
              {t('house.watchIntro')}
            </button>
          )}
          <a className="house-btn" href="#start-your-own">
            {t('house.startYourOwn')}
          </a>
        </div>
      </header>

      {house.agents.length > 0 && (
        <div className="house-cards">
          {house.agents.map((m, i) => (
            <MemberCard
              key={m.id}
              m={m}
              index={i}
              onOpen={() => host.navCtx.openView('house', { member: m.preferredUsername })}
              onTalk={() => talk(m)}
            />
          ))}
        </div>
      )}

      {house.people.length > 0 && (
        <section className="house-people" aria-label={t('channelSidebar.people')}>
          <h2 className="house-section-title">{t('house.peopleHere')}</h2>
          <ul>
            {house.people.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => host.navCtx.openView('house', { member: m.preferredUsername })}
                >
                  <Face m={m} size="small" />
                  <span>{nameOf(m)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="house-own" id="start-your-own" data-tour="start-your-own">
        <h2 className="house-own-title">{t('house.ownTitle')}</h2>
        <p className="house-own-text">{t('house.ownText')}</p>
        <a
          className="house-btn house-btn-solid"
          href={DEFAULT_HREF}
          target="_blank"
          rel="noreferrer"
        >
          {t('house.ownCta')}
        </a>
      </section>
    </div>
  );
}
