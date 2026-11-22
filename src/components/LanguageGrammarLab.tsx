import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  BookOpenCheck,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Languages,
  Loader2,
  Mic,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { OpenStudyState, StudyLanguage, TutorMode } from '../types';
import { generateStudyText } from '../services/providers';

export interface LanguageGrammarLabProps {
  state: OpenStudyState;
  onOpenVoiceTutor: (opts?: { mode?: TutorMode; language?: StudyLanguage; bilingual?: boolean }) => void;
}

interface GrammarExercise {
  id: string;
  topic: string;
  prompt: string;
  options: [string, string, string, string];
  correctIndex: number;
  explanation: string;
}

interface LanguageSpec {
  code: StudyLanguage;
  short: string;
  label: string;
  nativeLabel: string;
  focusAreas: string;
  sampleSentence: string;
  placeholder: string;
  exercises: GrammarExercise[];
}

const LANGUAGE_SPECS: LanguageSpec[] = [
  {
    code: 'en',
    short: 'EN',
    label: 'Englisch',
    nativeLabel: 'English',
    focusAreas: 'Conditionals, Tenses, Reported Speech',
    sampleSentence:
      'If I would have more time yesterday, I have finished the biology summary earlier.',
    placeholder: 'Schreibe einen englischen Satz oder kurzen Absatz zur Grammatik- und Stilprüfung...',
    exercises: [
      {
        id: 'en-g1',
        topic: 'Conditionals Type 2',
        prompt: 'If she ___ closer to the library, she would study there every afternoon.',
        options: ['would live', 'lived', 'lives', 'had lived'],
        correctIndex: 1,
        explanation:
          'Im Conditional Type 2 (irreale Gegenwart) steht im if-Satz immer Past Simple («lived») und im Hauptsatz «would + Infinitiv». Nie «would» im if-Satz verwenden.',
      },
      {
        id: 'en-g2',
        topic: 'Present Perfect vs. Past Simple',
        prompt: 'We ___ this chapter twice since Monday, so we feel well prepared.',
        options: ['reviewed', 'are reviewing', 'have reviewed', 'had reviewed'],
        correctIndex: 2,
        explanation:
          '«Since Monday» markiert einen Zeitraum bis in die Gegenwart. Dafür verlangt das Englische Present Perfect («have reviewed»).',
      },
      {
        id: 'en-g3',
        topic: 'Conditionals Type 3',
        prompt: 'If they had checked the timetable, they ___ the morning train.',
        options: ['would catch', 'caught', 'will have caught', 'would have caught'],
        correctIndex: 3,
        explanation:
          'Conditional Type 3 beschreibt eine irreale Vergangenheit: If + Past Perfect («had checked»), Hauptsatz mit «would have + Past Participle» («would have caught»).',
      },
      {
        id: 'en-g4',
        topic: 'Reported Speech',
        prompt: 'Direct: "I can explain the diagram tomorrow," Maya said. → Maya said that she ___ the diagram the next day.',
        options: ['could explain', 'can explain', 'explained', 'will explain'],
        correctIndex: 0,
        explanation:
          'Nach einem einleitenden Verb in der Vergangenheit («said») erfolgt der Backshift: «can» wird zu «could» und «tomorrow» zu «the next day».',
      },
    ],
  },
  {
    code: 'de',
    short: 'DE',
    label: 'Deutsch',
    nativeLabel: 'Deutsch',
    focusAreas: 'Kasus, Konjunktiv I, Satzbau',
    sampleSentence:
      'Wegen dem starken Regen wurde das Training abgesagt, obwohl wir hatten uns gut vorbereitet.',
    placeholder: 'Schreibe einen deutschen Satz oder kurzen Absatz zur Grammatik- und Stilprüfung...',
    exercises: [
      {
        id: 'de-g1',
        topic: 'Kasus (Genitiv)',
        prompt: 'Wegen ___ musste das Experiment auf Freitag verschoben werden.',
        options: ['dem starken Regen', 'des starken Regens', 'den starken Regen', 'der starke Regen'],
        correctIndex: 1,
        explanation:
          'Die Präposition «wegen» verlangt in der Standardsprache den Genitiv: «des starken Regens».',
      },
      {
        id: 'de-g2',
        topic: 'Konjunktiv I (Indirekte Rede)',
        prompt: 'Die Forscherin erklärte, das Ergebnis ___ noch weiter überprüft werden.',
        options: ['muss', 'müsse', 'musste', 'müssen'],
        correctIndex: 1,
        explanation:
          'Für neutrale indirekte Rede wird der Konjunktiv I verwendet. Bei «müssen» in der 3. Person Singular lautet die Form «müsse».',
      },
      {
        id: 'de-g3',
        topic: 'Satzbau (Nebensatz)',
        prompt: 'Welcher Satz zeigt die korrekte Verbstellung mit der Konjunktion «obwohl»?',
        options: [
          'Obwohl das Thema ist komplex, lassen sich die Grundlagen schnell verstehen.',
          'Obwohl das Thema komplex ist, die Grundlagen lassen sich schnell verstehen.',
          'Obwohl das Thema komplex ist, lassen sich die Grundlagen schnell verstehen.',
          'Obwohl ist das Thema komplex, lassen sich die Grundlagen schnell verstehen.',
        ],
        correctIndex: 2,
        explanation:
          'Nach «obwohl» steht das finite Verb am Ende des Nebensatzes («komplex ist»). Der folgende Hauptsatz beginnt direkt mit dem finiten Verb («lassen»).',
      },
      {
        id: 'de-g4',
        topic: 'Wechselpräposition (Dativ vs. Akkusativ)',
        prompt: 'Das Lehrbuch liegt bereits auf ___ Schreibtisch.',
        options: ['den', 'dem', 'des', 'der'],
        correctIndex: 1,
        explanation:
          'Bei Wechselpräpositionen («auf», «in», «an») antwortet der Dativ auf die Frage «Wo?» (Position): auf dem Schreibtisch.',
      },
    ],
  },
  {
    code: 'fr',
    short: 'FR',
    label: 'Französisch',
    nativeLabel: 'Français',
    focusAreas: 'Passé Composé vs. Imparfait, Subjonctif',
    sampleSentence:
      'Hier soir, je relisais mes notes quand le téléphone sonnait, et il faut que je finis ce chapitre.',
    placeholder: 'Schreibe einen französischen Satz oder kurzen Absatz zur Prüfung...',
    exercises: [
      {
        id: 'fr-g1',
        topic: 'Passé Composé vs. Imparfait',
        prompt: 'Hier soir, je ___ mes notes quand le téléphone a sonné.',
        options: ['ai relu', 'relisais', 'relirai', 'relis'],
        correctIndex: 1,
        explanation:
          'Die laufende Hintergrundhandlung steht im Imparfait («relisais»), während das plötzlich eintretende Ereignis im Passé Composé steht («a sonné»).',
      },
      {
        id: 'fr-g2',
        topic: 'Passé Composé (Accord mit être)',
        prompt: 'Claire et Léa ___ tôt à la bibliothèque ce matin.',
        options: ['ont arrivé', 'sont arrivé', 'sont arrivées', 'sont arrivés'],
        correctIndex: 2,
        explanation:
          'Das Verb «arriver» bildet das Passé Composé mit «être». Das Partizip gleicht sich in Geschlecht und Zahl an das weibliche Plural-Subjekt an: «arrivées».',
      },
      {
        id: 'fr-g3',
        topic: 'Subjonctif Présent',
        prompt: 'Il faut que tu ___ cet exercice avant le cours de demain.',
        options: ['finis', 'finisses', 'finiras', 'finissais'],
        correctIndex: 1,
        explanation:
          'Nach «il faut que» verlangt das Französische den Subjonctif Présent. Bei «finir» lautet die Form der 2. Person Singular «que tu finisses».',
      },
      {
        id: 'fr-g4',
        topic: 'Imparfait (Gewohnheit)',
        prompt: 'Quand nous étions plus jeunes, nous ___ souvent en groupe.',
        options: ['avons travaillé', 'travaillerons', 'travaillions', 'travaillons'],
        correctIndex: 2,
        explanation:
          'Wiederholte Gewohnheiten in der Vergangenheit werden im Französischen mit dem Imparfait ausgedrückt («travaillions»).',
      },
    ],
  },
  {
    code: 'es',
    short: 'ES',
    label: 'Spanisch',
    nativeLabel: 'Español',
    focusAreas: 'Ser vs. Estar, Pretérito Indefinido vs. Imperfecto',
    sampleSentence:
      'Ayer la biblioteca fue cerrada, pero normalmente es muy tranquila para estudiar.',
    placeholder: 'Schreibe einen spanischen Satz oder kurzen Absatz zur Prüfung...',
    exercises: [
      {
        id: 'es-g1',
        topic: 'Ser vs. Estar (Zustand)',
        prompt: 'La biblioteca ___ cerrada hoy por trabajos de renovación.',
        options: ['es', 'está', 'son', 'están'],
        correctIndex: 1,
        explanation:
          'Für einen vorübergehenden Zustand oder das Ergebnis einer Handlung («geschlossen sein») wird im Spanischen «estar» verwendet («está cerrada»).',
      },
      {
        id: 'es-g2',
        topic: 'Ser vs. Estar (Eigenschaft)',
        prompt: 'Este diccionario ___ muy útil para repasar verbos irregulares.',
        options: ['está', 'estuvo', 'es', 'estaba'],
        correctIndex: 2,
        explanation:
          'Grundlegende, dauerhafte Eigenschaften oder Bewertungen eines Gegenstands stehen mit «ser» («es muy útil»).',
      },
      {
        id: 'es-g3',
        topic: 'Pretérito Indefinido',
        prompt: 'Ayer por la tarde, Marta ___ todo el capítulo en una hora.',
        options: ['terminaba', 'terminó', 'termina', 'ha terminado'],
        correctIndex: 1,
        explanation:
          'Mit einem klar abgeschlossenen Zeitpunkt in der Vergangenheit («ayer por la tarde») steht das Pretérito Indefinido («terminó»).',
      },
      {
        id: 'es-g4',
        topic: 'Pretérito Imperfecto',
        prompt: 'Mientras ___ el resumen, escuchaba música instrumental.',
        options: ['escribí', 'escribo', 'escribía', 'escribiré'],
        correctIndex: 2,
        explanation:
          'Zwei gleichzeitig laufende Hintergrundhandlungen in der Vergangenheit («mientras») stehen beide im Pretérito Imperfecto («escribía»).',
      },
    ],
  },
  {
    code: 'it',
    short: 'IT',
    label: 'Italienisch',
    nativeLabel: 'Italiano',
    focusAreas: 'Passato Prossimo, Congiuntivo, Preposizioni',
    sampleSentence:
      'Ieri abbiamo andato in biblioteca e penso che questo libro è molto chiaro.',
    placeholder: 'Schreibe einen italienischen Satz oder kurzen Absatz zur Prüfung...',
    exercises: [
      {
        id: 'it-g1',
        topic: 'Passato Prossimo (essere)',
        prompt: 'Ieri sera noi ___ al museo scientifico del centro.',
        options: ['abbiamo andato', 'siamo andato', 'siamo andati', 'abbiamo andati'],
        correctIndex: 2,
        explanation:
          'Das Bewegungsverb «andare» bildet das Passato Prossimo mit «essere». Das Partizip passt sich im Plural an: «siamo andati».',
      },
      {
        id: 'it-g2',
        topic: 'Passato Prossimo (unregelmässiges Partizip)',
        prompt: 'Marco ___ un ottimo riassunto per la lezione di storia.',
        options: ['ha scrivuto', 'è scritto', 'ha scritto', 'ha scrivere'],
        correctIndex: 2,
        explanation:
          '«Scrivere» ist transitiv (Hilfsverb «avere») und hat das unregelmässige Partizip «scritto».',
      },
      {
        id: 'it-g3',
        topic: 'Congiuntivo Presente',
        prompt: 'Penso che questo esercizio ___ molto chiaro e utile.',
        options: ['è', 'sia', 'fosse', 'sarà'],
        correctIndex: 1,
        explanation:
          'Nach Meinungsverben wie «pensare che» oder «credere che» folgt im Italienischen der Congiuntivo Presente («sia» von «essere»).',
      },
      {
        id: 'it-g4',
        topic: 'Preposizioni articolate',
        prompt: 'Studio spesso ___ biblioteca del quartiere dopo le lezioni.',
        options: ['in la', 'nella', 'sulla', 'della'],
        correctIndex: 1,
        explanation:
          'Die Präposition «in» verschmilzt mit dem femininen Artikel «la» zu «nella» («nella biblioteca»).',
      },
    ],
  },
];

const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const;

export const LanguageGrammarLab: React.FC<LanguageGrammarLabProps> = ({
  state,
  onOpenVoiceTutor,
}) => {
  const [selectedLang, setSelectedLang] = useState<StudyLanguage>('en');
  const [bilingualHelp, setBilingualHelp] = useState<boolean>(state.voice.bilingualCoach);
  const [exerciseIndexByLang, setExerciseIndexByLang] = useState<Record<StudyLanguage, number>>({
    de: 0,
    en: 0,
    fr: 0,
    es: 0,
    it: 0,
  });
  const [answers, setAnswers] = useState<Record<string, number>>({});

  // AI Grammar & Style Checker state
  const [draftText, setDraftText] = useState<string>('');
  const [isChecking, setIsChecking] = useState<boolean>(false);
  const [checkResult, setCheckResult] = useState<{
    text: string;
    usedProvider: string;
    lang: StudyLanguage;
  } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);

  const spec = useMemo(
    () => LANGUAGE_SPECS.find((l) => l.code === selectedLang) ?? LANGUAGE_SPECS[0],
    [selectedLang]
  );

  const currentExerciseIndex = exerciseIndexByLang[selectedLang] ?? 0;
  const currentExercise = spec.exercises[currentExerciseIndex] ?? spec.exercises[0];
  const chosenOption = answers[currentExercise.id];
  const isAnswered = chosenOption !== undefined;
  const isCorrect = isAnswered && chosenOption === currentExercise.correctIndex;

  const langProgress = useMemo(() => {
    let answered = 0;
    let correct = 0;
    for (const ex of spec.exercises) {
      if (answers[ex.id] !== undefined) {
        answered += 1;
        if (answers[ex.id] === ex.correctIndex) correct += 1;
      }
    }
    return { answered, correct, total: spec.exercises.length };
  }, [spec.exercises, answers]);

  const setCurrentIndex = (idx: number) => {
    const clamped = Math.max(0, Math.min(spec.exercises.length - 1, idx));
    setExerciseIndexByLang((prev) => ({ ...prev, [selectedLang]: clamped }));
  };

  const handleSelectOption = (optionIdx: number) => {
    if (isAnswered) return;
    setAnswers((prev) => ({ ...prev, [currentExercise.id]: optionIdx }));
  };

  const handleResetLanguageDrills = () => {
    setAnswers((prev) => {
      const next = { ...prev };
      for (const ex of spec.exercises) {
        delete next[ex.id];
      }
      return next;
    });
    setCurrentIndex(0);
  };

  const handleCheckGrammar = async () => {
    const trimmed = draftText.trim();
    if (!trimmed || isChecking) return;

    setIsChecking(true);
    setCheckError(null);

    const systemPrompt = [
      `Du bist ein ruhiger, präziser Sprach- und Grammatik-Coach für ${spec.label} (${spec.nativeLabel}).`,
      'Prüfe den eingereichten Text auf Grammatik, Zeitformen, Wortstellung, Rechtschreibung und natürlichen Stil.',
      'Strukturiere deine Antwort klar und kompakt auf Deutsch:',
      '1. Korrigierte Version (in der Zielsprache)',
      '2. Konkrete Verbesserungen (maximal 4 Punkte mit kurzer, verständlicher Erklärung)',
      '3. Ein kurzer Tipp zum Weiterüben',
      'Bleibe freundlich, sachlich und vermeide unnötige Floskeln.',
    ].join('\n');

    const userPrompt = `Zielsprache: ${spec.nativeLabel}\nText der lernenden Person:\n"""\n${trimmed}\n"""`;

    try {
      const res = await generateStudyText({
        provider: state.provider,
        systemPrompt,
        userPrompt,
      });
      setCheckResult({
        text: res.text,
        usedProvider: res.usedProvider,
        lang: selectedLang,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Die KI-Textprüfung konnte nicht ausgeführt werden.';
      setCheckError(message);
    } finally {
      setIsChecking(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-10 animate-enter">
      {/* Header */}
      <header
        className="flex flex-col gap-3 border-b pb-5 sm:flex-row sm:items-end sm:justify-between"
        style={{ borderColor: 'var(--border-hairline)' }}
      >
        <div>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            Fünf Lernsprachen mit kuratierten Übungen, Textprüfung und striktem Language-Lock
          </p>
          <h1
            className="font-display font-normal mt-1 text-[30px] sm:text-[34px] leading-[1.15]"
            style={{ color: 'var(--text-primary)' }}
          >
            Sprachen & Grammatik-Labor
          </h1>
        </div>
        <div className="flex items-center gap-2 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          <Languages size={15} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
          <span>{spec.nativeLabel}</span>
          <span style={{ color: 'var(--border-strong)' }}>·</span>
          <span>{spec.focusAreas}</span>
        </div>
      </header>

      {/* 5 Language Tabs (clean editorial underline strip) */}
      <nav
        className="flex flex-wrap gap-6 border-b"
        style={{ borderColor: 'var(--border-hairline)' }}
        aria-label="Sprache auswählen"
      >
        {LANGUAGE_SPECS.map((lang) => {
          const active = lang.code === selectedLang;
          const solvedCount = lang.exercises.filter((e) => answers[e.id] === e.correctIndex).length;
          return (
            <button
              key={lang.code}
              type="button"
              onClick={() => {
                setSelectedLang(lang.code);
                setCheckError(null);
              }}
              className="relative flex items-baseline gap-2 pb-3 text-left transition-colors cursor-pointer"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              }}
            >
              <span
                className="font-mono-num text-[11.5px] font-medium"
                style={{
                  color: active ? 'var(--accent)' : 'var(--text-muted)',
                }}
              >
                {lang.short}
              </span>
              <span className="text-[14.5px] font-medium">{lang.nativeLabel}</span>
              <span className="font-mono-num text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                {solvedCount}/{lang.exercises.length}
              </span>
              {active && (
                <span
                  className="absolute inset-x-0 -bottom-px h-[2px] rounded-full"
                  style={{ backgroundColor: 'var(--accent)' }}
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* 1-Click Language-Lock Voice Tutor Card */}
      <section className="surface-card flex flex-col gap-5 p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: 'var(--accent-warm)' }}
            />
            <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
              Language-Lock: {spec.nativeLabel}
            </span>
            <span style={{ color: 'var(--border-strong)' }}>·</span>
            <span style={{ color: 'var(--text-muted)' }}>
              Echtzeit-Konversation ohne ungewollten Sprachwechsel
            </span>
          </div>
          <h2
            className="font-display font-normal text-[21px] leading-snug"
            style={{ color: 'var(--text-primary)' }}
          >
            Mündlich auf {spec.label} trainieren
          </h2>
          <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Der Sprachtutor bleibt konsequent auf {spec.nativeLabel} und korrigiert behutsam Ausdruck, Zeitformen und Aussprache.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center shrink-0">
          <label className="inline-flex items-center gap-2.5 text-[13px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
            <input
              type="checkbox"
              checked={bilingualHelp}
              onChange={(e) => setBilingualHelp(e.target.checked)}
              className="h-4 w-4 rounded accent-[var(--accent)] cursor-pointer"
            />
            <span>Kurze Grammatik-Hilfe auf Deutsch</span>
          </label>
          <button
            type="button"
            onClick={() =>
              onOpenVoiceTutor({
                mode: 'language',
                language: selectedLang,
                bilingual: bilingualHelp,
              })
            }
            className="btn-accent shrink-0"
          >
            <Mic size={16} strokeWidth={1.5} />
            <span>Auf {spec.nativeLabel} sprechen</span>
          </button>
        </div>
      </section>

      {/* Main Split: Interactive Drills + Grammar Checker */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left: Interactive Grammar Exercises */}
        <section className="surface-card flex flex-col justify-between p-6 xl:col-span-6">
          <div>
            <div
              className="flex flex-wrap items-center justify-between gap-2 border-b pb-3.5"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div className="flex items-center gap-2">
                <BookOpenCheck size={17} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
                <h2
                  className="font-display font-normal text-[21px] leading-snug"
                  style={{ color: 'var(--text-primary)' }}
                >
                  Grammatik-Übungen
                </h2>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono-num text-[12.5px]" style={{ color: 'var(--text-secondary)' }}>
                  {langProgress.correct} / {langProgress.total} richtig
                </span>
                {langProgress.answered > 0 && (
                  <button
                    type="button"
                    onClick={handleResetLanguageDrills}
                    className="btn-ghost h-7 px-2 text-[12px]"
                  >
                    <RotateCcw size={13} strokeWidth={1.5} />
                    <span>Neu starten</span>
                  </button>
                )}
              </div>
            </div>

            {/* Exercise stepper */}
            <div className="mt-4 flex flex-wrap items-center gap-1.5">
              {spec.exercises.map((ex, idx) => {
                const ans = answers[ex.id];
                const solved = ans !== undefined;
                const right = solved && ans === ex.correctIndex;
                const active = idx === currentExerciseIndex;
                return (
                  <button
                    key={ex.id}
                    type="button"
                    onClick={() => setCurrentIndex(idx)}
                    className="font-mono-num flex h-7 min-w-[30px] items-center justify-center rounded-full border px-2 text-[12px] font-medium transition-colors cursor-pointer"
                    style={{
                      backgroundColor: active
                        ? 'var(--text-primary)'
                        : solved
                        ? right
                          ? 'var(--positive-soft)'
                          : 'var(--negative-soft)'
                        : 'transparent',
                      color: active
                        ? 'var(--bg-card)'
                        : solved
                        ? right
                          ? 'var(--positive)'
                          : 'var(--negative)'
                        : 'var(--text-secondary)',
                      borderColor: active ? 'transparent' : 'var(--border-hairline)',
                    }}
                  >
                    <span>{idx + 1}</span>
                  </button>
                );
              })}
              <span className="ml-2 text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
                {currentExercise.topic}
              </span>
            </div>

            {/* Exercise prompt directly on editorial canvas */}
            <div className="my-5">
              <p
                className="font-display font-normal text-[21px] leading-[1.4]"
                style={{ color: 'var(--text-primary)' }}
              >
                {currentExercise.prompt}
              </p>
            </div>

            {/* Options as crisp hairline rows */}
            <div className="divide-y border-y" style={{ borderColor: 'var(--border-hairline)' }}>
              {currentExercise.options.map((option, idx) => {
                const isSelected = chosenOption === idx;
                const isRightOption = idx === currentExercise.correctIndex;

                let bg = 'transparent';
                let text = 'var(--text-primary)';

                if (isAnswered) {
                  if (isRightOption) {
                    bg = 'var(--positive-soft)';
                    text = 'var(--text-primary)';
                  } else if (isSelected) {
                    bg = 'var(--negative-soft)';
                    text = 'var(--text-primary)';
                  } else {
                    text = 'var(--text-muted)';
                  }
                }

                return (
                  <button
                    key={option}
                    type="button"
                    disabled={isAnswered}
                    onClick={() => handleSelectOption(idx)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left transition-colors cursor-pointer disabled:cursor-default hover:bg-[var(--bg-page)]/70"
                    style={{
                      backgroundColor: bg,
                      borderColor: 'var(--border-hairline)',
                      color: text,
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="keycap shrink-0">{OPTION_KEYS[idx]}</span>
                      <span className="text-[14.5px]">{option}</span>
                    </div>
                    {isAnswered && isRightOption && (
                      <CheckCircle2 size={16} strokeWidth={1.5} style={{ color: 'var(--positive)' }} className="shrink-0" />
                    )}
                    {isAnswered && isSelected && !isRightOption && (
                      <XCircle size={16} strokeWidth={1.5} style={{ color: 'var(--negative)' }} className="shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Instant Explanation (flat editorial left rule) */}
            {isAnswered && (
              <div
                className="mt-4 border-l-2 py-1 pl-3.5 text-[13.5px] leading-relaxed"
                style={{
                  borderColor: isCorrect ? 'var(--positive)' : 'var(--accent-warm)',
                  color: 'var(--text-primary)',
                }}
              >
                <p className="font-medium" style={{ color: isCorrect ? 'var(--positive)' : 'var(--accent-warm)' }}>
                  {isCorrect ? 'Richtig gelöst' : 'Kurze Erklärung'}
                </p>
                <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                  {currentExercise.explanation}
                </p>
              </div>
            )}
          </div>

          {/* Prev / Next Footer */}
          <div
            className="mt-6 flex items-center justify-between border-t pt-4"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <button
              type="button"
              disabled={currentExerciseIndex === 0}
              onClick={() => setCurrentIndex(currentExerciseIndex - 1)}
              className="btn-secondary h-8 px-3.5 text-[13px] disabled:opacity-45"
            >
              <ChevronLeft size={14} strokeWidth={1.5} />
              <span>Vorherige</span>
            </button>
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
              Übung {currentExerciseIndex + 1} von {spec.exercises.length}
            </span>
            <button
              type="button"
              disabled={currentExerciseIndex >= spec.exercises.length - 1}
              onClick={() => setCurrentIndex(currentExerciseIndex + 1)}
              className="btn-secondary h-8 px-3.5 text-[13px] disabled:opacity-45"
            >
              <span>Nächste</span>
              <ChevronRight size={14} strokeWidth={1.5} />
            </button>
          </div>
        </section>

        {/* Right: Grammar & Style Checker */}
        <section className="surface-card flex flex-col p-6 xl:col-span-6">
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b pb-3.5"
            style={{ borderColor: 'var(--border-hairline)' }}
          >
            <div className="flex items-center gap-2">
              <FileCheck2 size={17} strokeWidth={1.5} style={{ color: 'var(--accent)' }} />
              <h2
                className="font-display font-normal text-[21px] leading-snug"
                style={{ color: 'var(--text-primary)' }}
              >
                Grammatik- & Text-Prüfer
              </h2>
            </div>
            <button
              type="button"
              onClick={() => {
                setDraftText(spec.sampleSentence);
                setCheckError(null);
              }}
              className="btn-ghost h-7 px-2.5 text-[12px]"
            >
              <span>Beispiel einfügen</span>
            </button>
          </div>

          <p className="mt-3.5 text-[13.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            Schreibe einen Satz oder kurzen Absatz auf {spec.label}. Du erhältst eine behutsame Korrektur mit verständlicher Erklärung.
          </p>

          <textarea
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            rows={5}
            placeholder={spec.placeholder}
            className="mt-3.5 w-full resize-y rounded-xl border p-3.5 text-[14.5px] leading-relaxed"
            style={{
              backgroundColor: 'var(--bg-page)',
              borderColor: 'var(--border-hairline)',
              color: 'var(--text-primary)',
            }}
          />

          <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono-num text-[12px]" style={{ color: 'var(--text-muted)' }}>
              {draftText.trim() ? `${draftText.trim().split(/\s+/).length} Wörter` : 'Bereit für Eingabe'}
            </span>
            <div className="flex items-center gap-2">
              {draftText && (
                <button
                  type="button"
                  onClick={() => {
                    setDraftText('');
                    setCheckResult(null);
                    setCheckError(null);
                  }}
                  className="btn-ghost"
                >
                  <span>Leeren</span>
                </button>
              )}
              <button
                type="button"
                onClick={handleCheckGrammar}
                disabled={!draftText.trim() || isChecking}
                className="btn-primary disabled:opacity-50"
              >
                {isChecking ? (
                  <>
                    <Loader2 size={15} strokeWidth={1.5} className="animate-spin" />
                    <span>Prüfe Text...</span>
                  </>
                ) : (
                  <>
                    <FileCheck2 size={15} strokeWidth={1.5} />
                    <span>Grammatik & Stil prüfen</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Setup hint / error */}
          {checkError && (
            <div
              className="mt-5 border-l-2 py-1 pl-3.5 text-[13px] leading-relaxed"
              style={{
                borderColor: 'var(--accent-warm)',
                color: 'var(--text-primary)',
              }}
            >
              <div className="flex items-start gap-2">
                <AlertCircle size={15} strokeWidth={1.5} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-warm)' }} />
                <div>
                  <p className="font-medium" style={{ color: 'var(--accent-warm)' }}>
                    KI-Provider noch nicht verbunden
                  </p>
                  <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                    {checkError}
                  </p>
                  <p className="mt-1.5 text-[12px]" style={{ color: 'var(--text-muted)' }}>
                    Hinweis: Öffne oben die Einstellungen und hinterlege einen Google AI Studio Schlüssel oder verbinde lokal laufendes Ollama.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Result section directly on canvas below hairline */}
          {checkResult && (
            <div
              className="mt-5 flex-1 border-t pt-4"
              style={{ borderColor: 'var(--border-hairline)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13.5px] font-medium" style={{ color: 'var(--text-primary)' }}>
                  Rückmeldung ({LANGUAGE_SPECS.find((l) => l.code === checkResult.lang)?.nativeLabel})
                </span>
                <span className="font-mono-num text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
                  {checkResult.usedProvider}
                </span>
              </div>
              <div
                className="mt-3 whitespace-pre-wrap text-[14.5px] leading-relaxed"
                style={{ color: 'var(--text-primary)' }}
              >
                {checkResult.text}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
