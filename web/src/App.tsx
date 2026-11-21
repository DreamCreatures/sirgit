import { Route, Routes } from 'react-router'
import HomePage from './features/home/HomePage'
import RepoPage from './features/repo/RepoPage'
import Toasts from './features/errors/Toasts'
import CredentialsModal from './features/modals/CredentialsModal'
import AppDialog from './ui/AppDialog'
import BusyOverlay from './ui/BusyOverlay'

export default function App() {
  return (
    <div className="h-full">
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/repository" element={<RepoPage />} />
      </Routes>
      <BusyOverlay />
      <Toasts />
      <CredentialsModal />
      <AppDialog />
    </div>
  )
}
