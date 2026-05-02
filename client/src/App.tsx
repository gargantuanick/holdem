import { Route, Routes, Navigate } from "react-router-dom";
import { LobbyPage } from "./pages/Lobby";
import { TablePage } from "./pages/Table";
import { LeaderboardPage } from "./pages/Leaderboard";
import { LoginGate } from "./components/LoginGate";
import { GameStateProvider } from "./hooks/useGameState";

export default function App() {
  return (
    <LoginGate>
      <GameStateProvider>
        <Routes>
          <Route path="/" element={<Navigate to="/lobby" replace />} />
          <Route path="/lobby" element={<LobbyPage />} />
          <Route path="/table/:tableId" element={<TablePage />} />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="*" element={<Navigate to="/lobby" replace />} />
        </Routes>
      </GameStateProvider>
    </LoginGate>
  );
}
