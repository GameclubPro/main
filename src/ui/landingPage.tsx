import {
  BookOpen,
  CalendarDays,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  Gamepad2,
  Gift,
  HardDriveDownload,
  LoaderCircle,
  MessageCircle,
  MonitorDown,
  Newspaper,
  Radio,
  Server,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import heroImage from '../assets/launcher-hero.png';
import { apiGet, type AuthProvider, type FlexUser } from '../authClient';
import { LAUNCHER_VERSION, WINDOWS_DOWNLOAD_EXE, WINDOWS_DOWNLOAD_PORTABLE } from '../launcherInfo';
import { SiteAuthPanel } from './siteAuth';

const navItems = [
  ['Главная', '#top'],
  ['Новости', '#news'],
  ['Форум', '#forum'],
  ['Правила', '#rules'],
  ['Серверы', '#servers'],
  ['Скачать', '#download'],
];

const newsItems = [
  {
    icon: Newspaper,
    title: 'VK ID уже подключен',
    text: 'Профиль сайта теперь создается через VK ID. Этот же аккаунт используется для привязки лаунчера.',
    meta: 'Сегодня',
  },
  {
    icon: HardDriveDownload,
    title: `Лаунчер ${LAUNCHER_VERSION}`,
    text: 'Автообновление проверяет актуальность лаунчера и клиентских файлов перед запуском игры.',
    meta: 'Windows',
  },
  {
    icon: Users,
    title: 'Форум готовится',
    text: 'Разделы для вопросов, жалоб, предложений и новостей уже заложены в структуру портала.',
    meta: 'Скоро',
  },
];

const serverCards = [
  {
    icon: Server,
    title: 'Java',
    address: 'flex-craft.ru',
    port: '25565',
    text: 'Основной вход для ПК. Лаунчер сам подготовит Fabric, Java и моды.',
  },
  {
    icon: Gamepad2,
    title: 'Bedrock',
    address: 'flex-craft.ru',
    port: '19132',
    text: 'Один мир для игроков с телефона и Windows Bedrock.',
  },
];

const quickStart = [
  'Скачай установщик FlexCraft',
  'Войди на сайте через VK ID',
  'Открой вход из лаунчера и подтверди профиль на сайте',
  'Нажми Играть, остальное лаунчер сделает сам',
];

const forumSections = [
  'Новости проекта',
  'Вопросы игроков',
  'Жалобы и апелляции',
  'Идеи и предложения',
];

function displayName(user: FlexUser): string {
  return user.displayName || user.nickname || user.login;
}

function NavAccount({ user, pending }: { user: FlexUser | null; pending: boolean }) {
  if (pending) {
    return (
      <span className="navProfile pending">
        <LoaderCircle size={17} className="spin" />
        <span>Проверяем</span>
      </span>
    );
  }

  if (user) {
    return (
      <a className="navProfile" href="#account">
        {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span><ShieldCheck size={17} /></span>}
        <strong>{displayName(user)}</strong>
      </a>
    );
  }

  return (
    <a className="navDownload" href="#account">
      <ShieldCheck size={17} />
      Войти
    </a>
  );
}

export function LandingPage() {
  const [user, setUser] = useState<FlexUser | null>(null);
  const [providers, setProviders] = useState<AuthProvider[]>([]);
  const [authPending, setAuthPending] = useState(true);

  useEffect(() => {
    let mounted = true;
    void apiGet('/auth/me')
      .then((result) => {
        if (!mounted) {
          return;
        }
        setUser(result.user ?? null);
        setProviders(result.providers ?? []);
      })
      .catch(() => {
        if (mounted) {
          setUser(null);
        }
      })
      .finally(() => {
        if (mounted) {
          setAuthPending(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <main className="siteShell">
      <header className="siteNav" aria-label="Основная навигация">
        <a className="brandMark" href="#top" aria-label="FlexCraft">
          <span className="brandIcon"><Gamepad2 size={20} /></span>
          <span>FlexCraft</span>
        </a>
        <nav>
          {navItems.map(([label, href]) => (
            <a href={href} key={href}>{label}</a>
          ))}
        </nav>
        <NavAccount user={user} pending={authPending} />
      </header>

      <section className="portalHero" id="top">
        <img className="portalHeroImage" src={heroImage} alt="Игровой пейзаж FlexCraft" />
        <div className="portalHeroShade" />
        <div className="portalHeroInner">
          <div className="portalHeroText">
            <p className="siteEyebrow"><Sparkles size={15} /> версия {LAUNCHER_VERSION}</p>
            <h1>FlexCraft</h1>
            <p className="siteLead">
              Сервер Minecraft с собственным Windows-лаунчером, VK ID профилем и автоматической проверкой обновлений перед игрой.
            </p>
            <div className="siteActions">
              <a className="primaryCta" href={WINDOWS_DOWNLOAD_EXE} download>
                <MonitorDown size={20} />
                Скачать лаунчер
              </a>
              <a className="secondaryCta" href="#account">
                Подключить профиль
                <ChevronRight size={18} />
              </a>
            </div>
          </div>

          <div className="portalStatusPanel">
            <span className="statusSignal"><Radio size={18} /> Онлайн-портал</span>
            <strong>flex-craft.ru</strong>
            <p>Java, Bedrock, форум, правила и личный профиль в одном месте.</p>
          </div>
        </div>
      </section>

      <div className="portalFrame">
        <main className="portalMain">
          <section className="portalSection" id="news">
            <div className="portalSectionHeader">
              <div>
                <p className="siteEyebrow"><Newspaper size={15} /> Новости</p>
                <h2>Последние обновления</h2>
              </div>
              <span className="portalMuted">Лента проекта</span>
            </div>
            <div className="newsGrid">
              {newsItems.map((item) => {
                const Icon = item.icon;
                return (
                  <article className="newsCard" key={item.title}>
                    <span className="featureIcon"><Icon size={22} /></span>
                    <div>
                      <small><CalendarDays size={14} /> {item.meta}</small>
                      <h3>{item.title}</h3>
                      <p>{item.text}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="portalSection" id="servers">
            <div className="portalSectionHeader">
              <div>
                <p className="siteEyebrow"><Server size={15} /> Серверы</p>
                <h2>Один мир для разных клиентов</h2>
              </div>
            </div>
            <div className="serverGrid">
              {serverCards.map((server) => {
                const Icon = server.icon;
                return (
                  <article className="serverCard" key={server.title}>
                    <span className="featureIcon"><Icon size={22} /></span>
                    <div>
                      <h3>{server.title}</h3>
                      <p>{server.text}</p>
                    </div>
                    <dl>
                      <div>
                        <dt>Адрес</dt>
                        <dd>{server.address}</dd>
                      </div>
                      <div>
                        <dt>Порт</dt>
                        <dd>{server.port}</dd>
                      </div>
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="portalSection" id="forum">
            <div className="portalSectionHeader">
              <div>
                <p className="siteEyebrow"><MessageCircle size={15} /> Форум</p>
                <h2>Разделы уже заложены</h2>
              </div>
              <span className="portalMuted">Скоро откроем</span>
            </div>
            <div className="forumGrid">
              {forumSections.map((section) => (
                <article className="placeholderCard" key={section}>
                  <MessageCircle size={20} />
                  <strong>{section}</strong>
                  <small>Пустой раздел, готов к наполнению.</small>
                </article>
              ))}
            </div>
          </section>

          <section className="portalSection" id="rules">
            <div className="portalSectionHeader">
              <div>
                <p className="siteEyebrow"><BookOpen size={15} /> Правила</p>
                <h2>Основа для правил сервера</h2>
              </div>
            </div>
            <div className="rulesGrid">
              <article className="ruleCard">
                <ClipboardList size={22} />
                <h3>Правила поведения</h3>
                <p>Текст правил пока не опубликован. Раздел оставлен на сайте, чтобы игроки сразу понимали, где он будет.</p>
              </article>
              <article className="ruleCard">
                <FileText size={22} />
                <h3>Заявки и апелляции</h3>
                <p>Позже здесь появятся формы для обращений, жалоб и восстановления доступа.</p>
              </article>
            </div>
          </section>
        </main>

        <aside className="portalSidebar">
          <SiteAuthPanel
            compact
            userOverride={user}
            providersOverride={providers}
            onUserChange={setUser}
            onProvidersChange={setProviders}
          />

          <section className="sideWidget">
            <p className="siteEyebrow"><Gamepad2 size={15} /> Быстрый старт</p>
            <ol className="quickStartList">
              {quickStart.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </section>

          <section className="sideWidget">
            <p className="siteEyebrow"><Gift size={15} /> Донат</p>
            <h3>Магазин готовится</h3>
            <p>Раздел можно подключить позже: наборы, косметика, привилегии и история платежей.</p>
          </section>

          <section className="sideWidget" id="download">
            <p className="siteEyebrow"><Download size={15} /> Скачать</p>
            <h3>FlexCraft Launcher</h3>
            <p>Основной вариант для Windows. Portable оставлен как запасной запуск без установки.</p>
            <div className="sidebarActions">
              <a className="primaryCta" href={WINDOWS_DOWNLOAD_EXE} download>
                <Download size={18} />
                Установщик
              </a>
              <a className="secondaryCta" href={WINDOWS_DOWNLOAD_PORTABLE} download>
                Portable
              </a>
            </div>
          </section>
        </aside>
      </div>

      <section className="downloadBand portalDownload">
        <div className="downloadPanel finalDownload">
          <div>
            <p className="siteEyebrow"><ShieldCheck size={15} /> Готово к игре</p>
            <h2>Лаунчер сам проверит обновления.</h2>
            <p>Если доступна новая версия лаунчера, появится окно обновления. Клиентские моды и файлы синхронизируются при запуске игры.</p>
          </div>
          <div className="downloadActions">
            <a className="primaryCta" href={WINDOWS_DOWNLOAD_EXE} download>
              <Download size={20} />
              Скачать для Windows
            </a>
            <a className="secondaryCta" href="#rules">
              Правила
              <ChevronRight size={18} />
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
