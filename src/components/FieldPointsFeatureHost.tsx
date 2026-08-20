import { useEffect, useState } from 'react'
import FieldPointsFeature from './FieldPointsFeature'

const FIELD_POINTS_CHANGED_EVENT = 'evren-field-points-changed'

export default function FieldPointsFeatureHost() {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const refresh = () => setVersion((value) => value + 1)
    window.addEventListener(FIELD_POINTS_CHANGED_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(FIELD_POINTS_CHANGED_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return <FieldPointsFeature key={version} />
}
