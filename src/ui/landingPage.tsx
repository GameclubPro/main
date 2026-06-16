import {
  Check,
  ChevronRight,
  Cpu,
  Download,
  FolderSync,
  Gamepad2,
  HardDriveDownload,
  Mail,
  MonitorDown,
  Server,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import heroImage from '../assets/launcher-hero.png';
import { LAUNCHER_VERSION, WINDOWS_DOWNLOAD_EXE, WINDOWS_DOWNLOAD_PORTABLE } from '../launcherInfo';
import { SiteAuthPanel } from './siteAuth';

const features = [
  {
    icon: HardDriveDownload,
    title: 'Fabric + моды',
    text: 'Карта, голос, защита территории и нужные клиентские файлы уже в сборке.',
  },
  {
    icon: Cpu,
    title: 'Java 25 внутри',
    text: 'Не нужно искать Java вручную: лаунчер использует готовую среду.',
  },
  {
    icon: Server,
    title: 'Быстрый вход',
    text: 'Сервер FlexCraft уже закреплен в настройках запуска.',
  },
  {
    icon: ShieldCheck,
    title: 'Локальный профиль',
    text: 'Профиль создается на компьютере без лишних сервисов.',
  },
];

const stats = [
  ['8 модов', 'уже внутри'],
  ['Java 25', 'без настройки'],
  ['Java + Bedrock', 'один мир'],
];

const serverRoutes = [
  {
    icon: Server,
    title: 'Java',
    address: 'flex-craft.ru',
    port: '25565',
    text: 'ПК через лаунчер FlexCraft или обычный Java-клиент.',
  },
  {
    icon: Smartphone,
    title: 'Bedrock',
    address: 'flex-craft.ru',
    port: '19132',
    text: 'Android и Windows Bedrock заходят в тот же мир.',
  },
];

const launchLines = ['Профиль готов', 'Моды на месте', 'Java встроена', 'Сервер выбран'];

export function LandingPage() {
  return (
    <main className="siteShell">
      <header className="siteNav" aria-label="Основная навигация">
        <a className="brandMark" href="#top" aria-label="FlexCraft">
          <span className="brandIcon"><Gamepad2 size={20} /></span>
          <span>FlexCraft</span>
        </a>
        <nav>
          <a href="#server">Сервер</a>
          <a href="#account">Аккаунт</a>
          <a href="#download">Скачать</a>
        </nav>
        <a className="navDownload" href="#account">
          <ShieldCheck size={17} />
          Войти
        </a>
      </header>

      <section className="siteHero" id="top">
        <img className="heroImage" src={heroImage} alt="Voxel-пейзаж с окном игрового лаунчера" />
        <div className="heroShade" />
        <div className="siteHeroInner">
          <div className="heroText">
            <p className="siteEyebrow"><Sparkles size={15} /> версия {LAUNCHER_VERSION}</p>
            <h1>FlexCraft</h1>
            <p className="siteLead">
              Готовая Windows-сборка: Fabric, моды, Java и вход на общий сервер flex-craft.ru.
            </p>
            <div className="siteActions">
              <a className="primaryCta" href={WINDOWS_DOWNLOAD_EXE} download>
                <MonitorDown size={20} />
                Скачать для Windows
              </a>
              <a className="secondaryCta" href="#server">
                Сервер
                <ChevronRight size={18} />
              </a>
            </div>
            <div className="heroStats" aria-label="Краткие параметры лаунчера">
              {stats.map(([value, label]) => (
                <span key={value}>
                  <strong>{value}</strong>
                  <small>{label}</small>
                </span>
              ))}
            </div>
          </div>

          <div className="launcherMockup" aria-label="Превью интерфейса лаунчера">
            <div className="mockTopbar">
              <span />
              <span />
              <span />
              <strong>FlexCraft</strong>
            </div>
            <div className="mockStatus">
              <small>ГОТОВО</small>
              <strong>flex-craft.ru</strong>
              <div className="mockProgress"><span /></div>
            </div>
            <ul className="mockGrid">
              {launchLines.map((line) => (
                <li key={line}><Check size={17} /> {line}</li>
              ))}
            </ul>
            <button className="mockPlay" type="button">
              <Gamepad2 size={19} />
              Играть
            </button>
          </div>
        </div>
      </section>

      <section className="featureBand" aria-label="Что внутри лаунчера">
        <div className="sectionIntro">
          <p className="siteEyebrow"><FolderSync size={15} /> Сборка</p>
          <h2>Минимум действий. Максимум готовности.</h2>
        </div>

        <div className="featureGrid">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <article className="featureCard" key={feature.title}>
                <span className="featureIcon"><Icon size={22} /></span>
                <h3>{feature.title}</h3>
                <p>{feature.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <section className="connectBand" id="server">
        <div className="sectionIntro">
          <p className="siteEyebrow"><Server size={15} /> Общий сервер</p>
          <h2>Один мир для ПК и телефона.</h2>
        </div>

        <div className="connectGrid">
          {serverRoutes.map((route) => {
            const Icon = route.icon;
            return (
              <article className="connectCard" key={route.title}>
                <span className="featureIcon"><Icon size={22} /></span>
                <div>
                  <h3>{route.title}</h3>
                  <p>{route.text}</p>
                </div>
                <dl>
                  <div>
                    <dt>Адрес</dt>
                    <dd>{route.address}</dd>
                  </div>
                  <div>
                    <dt>Порт</dt>
                    <dd>{route.port}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </section>

      <section className="accountBand" id="account">
        <div className="sectionIntro">
          <p className="siteEyebrow"><ShieldCheck size={15} /> Аккаунт FlexCraft</p>
          <h2>Один профиль для сайта и лаунчера.</h2>
          <p>Создайте аккаунт через email и пароль. После подтверждения почты этот же профиль можно подключить в лаунчере.</p>
        </div>
        <div className="accountBandGrid">
          <SiteAuthPanel />
          <div className="accountInfoPanel">
            <span className="featureIcon"><Mail size={22} /></span>
            <h3>Email-подтверждение</h3>
            <p>После регистрации придёт ссылка. Аккаунт станет активным только после подтверждения, чтобы защитить ники и восстановление доступа.</p>
            <ul>
              <li><Check size={17} /> Пароль хранится только как защищённый hash</li>
              <li><Check size={17} /> Сессия сайта хранится в HttpOnly cookie</li>
              <li><Check size={17} /> Лаунчер подключается через браузерный код</li>
            </ul>
          </div>
        </div>
      </section>

      <section className="downloadBand" id="download">
        <div className="downloadPanel finalDownload">
          <div>
            <p className="siteEyebrow"><Download size={15} /> Windows</p>
            <h2>Скачай. Запусти. Играй.</h2>
            <p>Основной файл: установщик <code>.exe</code>. Portable оставлен как запасной вариант без установки.</p>
          </div>
          <div className="downloadActions">
            <a className="primaryCta" href={WINDOWS_DOWNLOAD_EXE} download>
              <Download size={20} />
              Скачать установщик
            </a>
            <a className="secondaryCta" href={WINDOWS_DOWNLOAD_PORTABLE} download>
              Portable-версия
              <ChevronRight size={18} />
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
