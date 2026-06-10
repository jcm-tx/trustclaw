'use client'
// src/app/portal/family/page.tsx
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'

interface Child {
  id: string
  name: string
  age: number | null
  school: string | null
  type: string
}

interface VillageMember {
  id: string
  name: string
  phone_number: string
  role: string
}

export default function PortalFamilyPage() {
  const [children, setChildren] = useState<Child[]>([])
  const [village, setVillage] = useState<VillageMember[]>([])
  const [loading, setLoading] = useState(true)
  const [editingChild, setEditingChild] = useState<Child | null>(null)
  const [addingChild, setAddingChild] = useState(false)
  const [addingVillage, setAddingVillage] = useState(false)
  const [newChild, setNewChild] = useState({ name: '', age: '', school: '', type: 'child' })
  const [newVillage, setNewVillage] = useState({ name: '', phone: '', role: 'village' })
  const [saving, setSaving] = useState(false)
  const router = useRouter()

  useEffect(() => { void loadData() }, [])

  async function loadData() {
    const res = await fetch('/api/portal/family')
    if (res.status === 401) { router.push('/portal'); return }
    const data = await res.json() as { children: Child[]; village: VillageMember[] }
    setChildren(data.children ?? [])
    setVillage(data.village ?? [])
    setLoading(false)
  }

  async function saveChild() {
    setSaving(true)
    await fetch('/api/portal/family', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'child',
        id: editingChild?.id,
        name: editingChild?.name ?? newChild.name,
        age: editingChild ? editingChild.age : (newChild.age ? parseInt(newChild.age) : null),
        school: editingChild?.school ?? newChild.school,
        childType: editingChild?.type ?? newChild.type,
      }),
    })
    setEditingChild(null)
    setAddingChild(false)
    setNewChild({ name: '', age: '', school: '', type: 'child' })
    await loadData()
    setSaving(false)
  }

  async function saveVillage() {
    setSaving(true)
    await fetch('/api/portal/family', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'village', ...newVillage }),
    })
    setAddingVillage(false)
    setNewVillage({ name: '', phone: '', role: 'village' })
    await loadData()
    setSaving(false)
  }

  async function deleteChild(id: string) {
    if (!confirm('Remove this person from your family?')) return
    await fetch('/api/portal/family', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type: 'child' }),
    })
    await loadData()
  }

  async function deleteVillage(id: string) {
    if (!confirm('Remove this village member?')) return
    await fetch('/api/portal/family', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, type: 'village' }),
    })
    await loadData()
  }

  const kids = children.filter(c => c.type !== 'elderly')
  const elderly = children.filter(c => c.type === 'elderly')

  if (loading) return <div style={styles.loading}>Loading...</div>

  return (
    <div style={styles.page}>
      <nav style={styles.nav}>
        <div style={styles.navLogo}>Life. Covered.</div>
        <div style={styles.navLinks}>
          <a href="/portal/home" style={styles.navLink}>Home</a>
          <a href="/portal/family" style={styles.navLinkActive}>Family</a>
          <a href="/portal/schedule" style={styles.navLink}>Schedule</a>
        </div>
      </nav>

      <div style={styles.content}>
        <h1 style={styles.pageTitle}>Your Family</h1>

        {/* Kids */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Kids</h2>
            <button onClick={() => setAddingChild(true)} style={styles.addBtn}>+ Add</button>
          </div>

          {addingChild && (
            <div style={styles.formCard}>
              <div style={styles.formRow}>
                <input placeholder="Name" value={newChild.name} onChange={e => setNewChild({...newChild, name: e.target.value})} style={styles.input} />
                <input placeholder="Age" type="number" value={newChild.age} onChange={e => setNewChild({...newChild, age: e.target.value})} style={{...styles.input, maxWidth: '80px'}} />
                <input placeholder="School (optional)" value={newChild.school} onChange={e => setNewChild({...newChild, school: e.target.value})} style={styles.input} />
                <select value={newChild.type} onChange={e => setNewChild({...newChild, type: e.target.value})} style={styles.select}>
                  <option value="child">Child</option>
                  <option value="elderly">Elderly dependent</option>
                </select>
              </div>
              <div style={styles.formActions}>
                <button onClick={saveChild} style={styles.saveBtn} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                <button onClick={() => setAddingChild(false)} style={styles.cancelBtn}>Cancel</button>
              </div>
            </div>
          )}

          {kids.length === 0 && !addingChild && (
            <div style={styles.empty}>No kids added yet. <button onClick={() => setAddingChild(true)} style={styles.inlineBtn}>Add one</button></div>
          )}

          {kids.map(child => (
            <div key={child.id} style={styles.personCard}>
              {editingChild?.id === child.id ? (
                <div>
                  <div style={styles.formRow}>
                    <input value={editingChild.name} onChange={e => setEditingChild({...editingChild, name: e.target.value})} style={styles.input} />
                    <input type="number" placeholder="Age" value={editingChild.age ?? ''} onChange={e => setEditingChild({...editingChild, age: e.target.value ? parseInt(e.target.value) : null})} style={{...styles.input, maxWidth: '80px'}} />
                    <input placeholder="School" value={editingChild.school ?? ''} onChange={e => setEditingChild({...editingChild, school: e.target.value})} style={styles.input} />
                  </div>
                  <div style={styles.formActions}>
                    <button onClick={saveChild} style={styles.saveBtn} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                    <button onClick={() => setEditingChild(null)} style={styles.cancelBtn}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={styles.personInfo}>
                    <div style={styles.personName}>{child.name}</div>
                    <div style={styles.personMeta}>
                      {child.age && <span>Age {child.age}</span>}
                      {child.school && <span> · {child.school}</span>}
                    </div>
                  </div>
                  <div style={styles.personActions}>
                    <button onClick={() => setEditingChild(child)} style={styles.editBtn}>Edit</button>
                    <button onClick={() => deleteChild(child.id)} style={styles.deleteBtn}>Remove</button>
                  </div>
                </>
              )}
            </div>
          ))}

          {/* Elderly */}
          {elderly.length > 0 && (
            <>
              <h3 style={styles.subTitle}>Elderly dependents</h3>
              {elderly.map(person => (
                <div key={person.id} style={styles.personCard}>
                  <div style={styles.personInfo}>
                    <div style={styles.personName}>{person.name}</div>
                    {person.age && <div style={styles.personMeta}>Age {person.age}</div>}
                  </div>
                  <div style={styles.personActions}>
                    <button onClick={() => setEditingChild(person)} style={styles.editBtn}>Edit</button>
                    <button onClick={() => deleteChild(person.id)} style={styles.deleteBtn}>Remove</button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        {/* Village */}
        <div style={styles.section}>
          <div style={styles.sectionHeader}>
            <h2 style={styles.sectionTitle}>Village</h2>
            <button onClick={() => setAddingVillage(true)} style={styles.addBtn}>+ Add</button>
          </div>

          {addingVillage && (
            <div style={styles.formCard}>
              <div style={styles.formRow}>
                <input placeholder="Name" value={newVillage.name} onChange={e => setNewVillage({...newVillage, name: e.target.value})} style={styles.input} />
                <input placeholder="Phone number" value={newVillage.phone} onChange={e => setNewVillage({...newVillage, phone: e.target.value})} style={styles.input} />
                <select value={newVillage.role} onChange={e => setNewVillage({...newVillage, role: e.target.value})} style={styles.select}>
                  <option value="village">Village member</option>
                  <option value="co-parent">Co-parent</option>
                  <option value="partner">Partner</option>
                  <option value="grandparent">Grandparent</option>
                  <option value="nanny">Nanny</option>
                </select>
              </div>
              <div style={styles.formActions}>
                <button onClick={saveVillage} style={styles.saveBtn} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
                <button onClick={() => setAddingVillage(false)} style={styles.cancelBtn}>Cancel</button>
              </div>
            </div>
          )}

          {village.length === 0 && !addingVillage && (
            <div style={styles.empty}>No village members yet. <button onClick={() => setAddingVillage(true)} style={styles.inlineBtn}>Add one</button></div>
          )}

          {village.map(member => (
            <div key={member.id} style={styles.personCard}>
              <div style={styles.personInfo}>
                <div style={styles.personName}>{member.name}</div>
                <div style={styles.personMeta}>{member.phone_number} · {member.role}</div>
              </div>
              <div style={styles.personActions}>
                <button onClick={() => deleteVillage(member.id)} style={styles.deleteBtn}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: '100vh', background: '#FAF7F2', fontFamily: "'DM Sans', -apple-system, sans-serif" },
  loading: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: '#78716C' },
  nav: { background: '#FFFFFF', borderBottom: '1px solid #E7E3DC', padding: '0 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '64px' },
  navLogo: { fontFamily: 'Georgia, serif', fontSize: '18px', fontWeight: '700', color: '#1C1917' },
  navLinks: { display: 'flex', alignItems: 'center', gap: '24px' },
  navLink: { fontSize: '14px', color: '#78716C', textDecoration: 'none', fontWeight: '500' },
  navLinkActive: { fontSize: '14px', color: '#2d6a4f', textDecoration: 'none', fontWeight: '600' },
  content: { maxWidth: '800px', margin: '0 auto', padding: '40px 24px' },
  pageTitle: { fontFamily: 'Georgia, serif', fontSize: '32px', fontWeight: '700', color: '#1C1917', margin: '0 0 32px' },
  section: { marginBottom: '48px' },
  sectionHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' },
  sectionTitle: { fontSize: '18px', fontWeight: '600', color: '#1C1917', margin: '0' },
  subTitle: { fontSize: '15px', fontWeight: '600', color: '#78716C', margin: '20px 0 12px' },
  addBtn: { background: '#2d6a4f', color: '#FFF', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
  formCard: { background: '#FFFFFF', borderRadius: '12px', padding: '20px', marginBottom: '12px', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  formRow: { display: 'flex', gap: '12px', flexWrap: 'wrap' },
  formActions: { display: 'flex', gap: '8px', marginTop: '12px' },
  input: { padding: '10px 12px', borderRadius: '8px', border: '1.5px solid #E7E3DC', fontSize: '14px', color: '#1C1917', background: '#FAF7F2', outline: 'none', flex: '1', minWidth: '120px' },
  select: { padding: '10px 12px', borderRadius: '8px', border: '1.5px solid #E7E3DC', fontSize: '14px', color: '#1C1917', background: '#FAF7F2', outline: 'none' },
  saveBtn: { background: '#2d6a4f', color: '#FFF', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' },
  cancelBtn: { background: 'none', color: '#78716C', border: '1px solid #E7E3DC', borderRadius: '8px', padding: '8px 16px', fontSize: '14px', cursor: 'pointer' },
  empty: { background: '#FFFFFF', borderRadius: '12px', padding: '24px', color: '#78716C', fontSize: '15px' },
  inlineBtn: { background: 'none', border: 'none', color: '#2d6a4f', fontSize: '15px', fontWeight: '500', cursor: 'pointer', padding: '0' },
  personCard: { background: '#FFFFFF', borderRadius: '12px', padding: '16px 20px', marginBottom: '8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
  personInfo: { flex: 1 },
  personName: { fontSize: '15px', fontWeight: '500', color: '#1C1917' },
  personMeta: { fontSize: '13px', color: '#78716C', marginTop: '2px' },
  personActions: { display: 'flex', gap: '8px' },
  editBtn: { background: 'none', border: '1px solid #E7E3DC', borderRadius: '6px', padding: '6px 12px', fontSize: '13px', color: '#44403C', cursor: 'pointer' },
  deleteBtn: { background: 'none', border: '1px solid #FCA5A5', borderRadius: '6px', padding: '6px 12px', fontSize: '13px', color: '#DC2626', cursor: 'pointer' },
}
